#!/usr/bin/env bash
# Installs a narrow image download bridge in the existing Obsidian Knowledge Hub.
# Host: CT118 obsidian-sync; invoked as root via pct exec 118.
set -Eeuo pipefail
umask 077

ROOT=/opt/obsidian-knowledge-hub
DEPLOY="$ROOT/deploy"
WRITER_COMPOSE="$DEPLOY/docker-compose.mcp-writer.yml"
HUB_RUNTIME="$ROOT/controlled-write-runtime.mjs"
BRIDGE="$ROOT/attachment-bridge.mjs"
UPSTREAM_IMAGE=ghcr.io/es617/obsidian-sync-mcp:v0.12.1
PAYLOAD_URL=https://raw.githubusercontent.com/Legon85/obsidian-sync-mcp/341b3ca25a7d3afd203b1b1d3abc9ca46b104487/deploy/bootstrap-attachment-bridge.mjs

if [[ "${EUID}" != 0 || "$(hostname)" != obsidian-sync ]]; then
  echo 'ERROR: must run as root INSIDE CT118 (hostname obsidian-sync)' >&2; exit 2
fi
for bin in docker python3 curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then echo "Missing command: $bin" >&2; exit 2; fi
done
NODE_IMAGE=$(docker inspect --format '{{.Config.Image}}' obsidian-knowledge-hub 2>/dev/null || true)
[[ "$NODE_IMAGE" == node:22-bookworm* ]] || { echo "Unexpected Knowledge Hub image; STOP" >&2; exit 2; }
check_js() { docker run --rm --network none --read-only -v "$TMP":/check:ro --entrypoint node "$NODE_IMAGE" --check "/check/$1"; }
[[ -r "$WRITER_COMPOSE" && -r "$HUB_RUNTIME" ]] || { echo 'Missing expected Obsidian deployment files' >&2; exit 2; }
[[ ! -e "$BRIDGE" ]] || { echo 'Attachment bridge already exists; refusing duplicate install' >&2; exit 2; }
cd "$DEPLOY"
[[ "$(docker inspect --format '{{.State.Running}}' obsidian-mcp-writer 2>/dev/null)" == true ]] || { echo 'Writer is not running' >&2; exit 2; }
[[ "$(docker inspect --format '{{.State.Running}}' obsidian-knowledge-hub 2>/dev/null)" == true ]] || { echo 'Knowledge Hub is not running' >&2; exit 2; }
[[ "$(docker inspect --format '{{.Config.Image}}' obsidian-mcp-writer)" == ghcr.io/legon85/obsidian-sync-mcp@sha256:* ]] || { echo 'Unexpected current writer image; STOP' >&2; exit 2; }
CURRENT_RO=$(docker inspect obsidian-mcp-writer --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^READ_ONLY=' | cut -d= -f2 || true)
[[ "$CURRENT_RO" == false ]] || { echo "Writer is not in expected READ_ONLY=false mode; STOP" >&2; exit 2; }
if ! docker compose -f "$WRITER_COMPOSE" config --quiet; then echo 'Invalid existing writer Compose' >&2; exit 2; fi

TMP=$(mktemp -d /tmp/obsidian-attachments-XXXXXXXX)
cp -p "$WRITER_COMPOSE" "$TMP/writer.yml"
cp -p "$HUB_RUNTIME" "$TMP/controlled-write-runtime.mjs"
WRITER_CHANGED=0; HUB_CHANGED=0
trap '[[ -z "${TMP:-}" || ! -d "${TMP:-}" ]] || rm -rf -- "$TMP"' EXIT
rollback() {
  set +e
  echo 'ERROR: bootstrap failed; restoring original writer and Knowledge Hub...' >&2
  if [[ "$HUB_CHANGED" == 1 ]]; then cp -p "$TMP/controlled-write-runtime.mjs" "$HUB_RUNTIME"; docker restart obsidian-knowledge-hub >/dev/null; fi
  if [[ "$WRITER_CHANGED" == 1 ]]; then cp -p "$TMP/writer.yml" "$WRITER_COMPOSE"; docker compose -f "$WRITER_COMPOSE" up -d --no-deps --no-build obsidian-mcp-writer >/dev/null; fi
  if [[ -e "$BRIDGE" ]]; then rm -f -- "$BRIDGE"; fi
  rm -rf -- "$TMP"
  echo 'Rollback attempted. Check both container health before further changes.' >&2
}
trap rollback ERR

note_hash() {
 docker exec obsidian-knowledge-hub node --input-type=module -e '
 import {createHash} from "node:crypto";
 const {readRawNote}=await import("/hub/controlled-write-runtime.mjs");
 const r=await readRawNote("Home/Главная — ПК.md");
 const c=typeof r==="string"?r:(r?.content??r?.raw_content);
 if(typeof c!=="string"||!c.includes("Главная")&&!c.includes("рабочий стол"))process.exit(15);
 process.stdout.write(createHash("sha256").update(c).digest("hex"));
 ' 2>/dev/null
}
BEFORE=$(note_hash) || { echo 'Cannot safely read existing homepage via writer; STOP' >&2; exit 2; }
[[ ${#BEFORE} == 64 ]] || { echo 'Invalid note read hash; STOP' >&2; exit 2; }

echo '1/5 Downloading pinned upstream writer...'
docker pull "$UPSTREAM_IMAGE" >/dev/null
NEW_IMAGE=$(docker image inspect "$UPSTREAM_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep '^ghcr.io/es617/obsidian-sync-mcp@sha256:' | head -1)
[[ -n "$NEW_IMAGE" ]] || { echo 'Cannot resolve immutable image digest' >&2; exit 2; }

# Prepare code and Compose replacement in staging. Fail closed on unknown layout.
echo '2/5 Preparing safe, scope-limited MCP attachment bridge...'
curl -fLsS --max-time 20 "$PAYLOAD_URL" -o "$TMP/attachment-bridge.mjs"
[[ $(wc -c < "$TMP/attachment-bridge.mjs") -gt 2500 ]] || { echo 'Bridge payload is unexpectedly small' >&2; exit 2; }
printf '%s  %s\n' f4457da639747f280b9ce5c9afd55b4e0a47dea6edaff1c42605b573fdad60bc "$TMP/attachment-bridge.mjs" | sha256sum --check --status || { echo 'Bridge SHA256 mismatch; STOP' >&2; exit 2; }
check_js attachment-bridge.mjs
NEW_IMAGE="$NEW_IMAGE" TMP="$TMP" WRITER_COMPOSE="$WRITER_COMPOSE" HUB_RUNTIME="$HUB_RUNTIME" python3 - <<'PY'
import os,re,pathlib
root=pathlib.Path(os.environ['TMP']); compose=pathlib.Path(os.environ['WRITER_COMPOSE']).read_text();runtime=pathlib.Path(os.environ['HUB_RUNTIME']).read_text()
new_image=os.environ['NEW_IMAGE']
if 'upload_attachment_from_url' in runtime or 'ATTACHMENTS_ENABLED' in compose: raise SystemExit('Attachment support may already be installed; STOP')
# Locate the writer service (only) and change its own environment block.
m=re.search(r'(?ms)^  obsidian-mcp-writer:\s*\n(?P<body>.*?)(?=^  [^\s#][^\n]*:\s*(?:#.*)?$|\Z)',compose)
if not m: raise SystemExit('Writer service block not found; STOP')
body=m.group('body')
image_match=re.search(r'(?m)^(?P<indent>\s+)image:\s*(?P<value>[^\n]+)$',body)
if not image_match or 'ghcr.io/legon85/obsidian-sync-mcp' not in image_match.group('value'): raise SystemExit('Unexpected writer image declaration; STOP')
body=body[:image_match.start('value')]+new_image+body[image_match.end('value'):]
envm=re.search(r'(?m)^(?P<indent>\s+)environment:\s*(?:#.*)?$',body)
if not envm: raise SystemExit('Writer service has no environment section; STOP')
start=envm.end();tail=body[start:]
next_line=re.search(r'(?m)^([ \t]*)(\S)',tail)
if not next_line: raise SystemExit('Empty environment section; STOP')
indent=next_line.group(1)
if len(indent)<=len(envm.group('indent')): raise SystemExit('Invalid environment nesting; STOP')
line=tail[next_line.start():].splitlines()[0].lstrip()
if line.startswith('- '):
    additions=''.join(f'\n{indent}- {key}={value}' for key,value in [('ATTACHMENTS_ENABLED','true'),('ATTACHMENT_MAX_BYTES','8388608'),('ATTACHMENT_EXTENSIONS','jpg,jpeg,png,webp,gif,avif')])
else:
    additions=''.join(f'\n{indent}{key}: "{value}"' for key,value in [('ATTACHMENTS_ENABLED','true'),('ATTACHMENT_MAX_BYTES','8388608'),('ATTACHMENT_EXTENSIONS','jpg,jpeg,png,webp,gif,avif')])
# Insertion immediately after 'environment:'; no other service affected.
body=body[:start]+additions+body[start:]
compose=compose[:m.start('body')]+body+compose[m.end('body'):]
(root/'writer.new.yml').write_text(compose)
# Hook our three operations into the already-exposed controlled-write registration.
pattern=r'export\s+const\s+controlledWriteTools\s*=\s*\['
match=re.search(pattern,runtime)
if not match: raise SystemExit('Unknown MCP registration layout; STOP')
new_tools='''
  {name: 'download_attachment_from_url', description: 'Download a public HTTPS image (JPEG, PNG, WebP, GIF, AVIF) to Assets/ in Obsidian through encrypted LiveSync, max 8 MiB. Never overwrites unless overwrite=true.', inputSchema:{type:'object',properties:{url:{type:'string'},path:{type:'string'},overwrite:{type:'boolean'}},required:['url','path'],additionalProperties:false}},
  {name: 'get_image_metadata', description: 'Get metadata of an image stored in Assets/.', inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  {name: 'list_image_attachments', description: 'List existing images and attachments in Assets/.', inputSchema:{type:'object',properties:{},additionalProperties:false}},
'''
runtime=runtime[:match.end()]+new_tools+runtime[match.end():]
branch=re.search(r"(?m)^([ \t]*)if\s*\(name\s*===\s*['\"]controlled_write_status['\"]\)\s*\{",runtime)
if not branch: raise SystemExit('Unknown MCP dispatch layout; STOP')
indent=branch.group(1)
injected='''if (name === 'download_attachment_from_url' || name === 'get_image_metadata' || name === 'list_image_attachments') {
  return await callAttachmentBridge(name, args, callWriterTool);
}
'''
runtime=runtime[:branch.start()]+''.join(indent+line+'\n' for line in injected.strip().splitlines())+runtime[branch.start():]
runtime="import { callAttachmentBridge } from './attachment-bridge.mjs';\n"+runtime
if 'controlledWriteToolNames' not in runtime: raise SystemExit('Tool set not found; STOP')
runtime+='\n// Attachment bridge tools are published with the existing Knowledge Hub tool set.\n'
runtime+='for (const name of ["download_attachment_from_url", "get_image_metadata", "list_image_attachments"]) controlledWriteToolNames.add(name);\n'
(root/'controlled-write-runtime.new.mjs').write_text(runtime)
PY
check_js controlled-write-runtime.new.mjs
# Validate newly composed config without exposing credentials.
cp -p "$TMP/writer.new.yml" "$WRITER_COMPOSE"
if ! docker compose -f "$WRITER_COMPOSE" config --quiet; then cp -p "$TMP/writer.yml" "$WRITER_COMPOSE"; echo 'New Compose config invalid; STOP' >&2; exit 2; fi
cp -p "$TMP/writer.yml" "$WRITER_COMPOSE"

echo '3/5 Updating only obsidian-mcp-writer (existing secrets and volumes preserved)...'
cp -p "$TMP/writer.new.yml" "$WRITER_COMPOSE"
WRITER_CHANGED=1
docker compose -f "$WRITER_COMPOSE" up -d --no-deps --no-build obsidian-mcp-writer >/dev/null
sleep 3
AFTER=''
for i in $(seq 1 40); do
  AFTER=$(note_hash 2>/dev/null || true)
  if [[ "$AFTER" == "$BEFORE" ]]; then break; fi
  sleep 3
done
[[ "$AFTER" == "$BEFORE" ]] || { echo 'Writer read-back mismatch or unavailable; rolling back' >&2; false; }

echo '4/5 Publishing image tools through the existing Knowledge Hub (no extra tunnel)...'
cp -p "$TMP/attachment-bridge.mjs" "$BRIDGE"
cp -p "$TMP/controlled-write-runtime.new.mjs" "$HUB_RUNTIME"
HUB_CHANGED=1
docker exec obsidian-knowledge-hub node --check /hub/controlled-write-runtime.mjs
docker restart obsidian-knowledge-hub >/dev/null
READY=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 http://192.168.2.224:8790/health >/dev/null 2>&1; then READY=1; break; fi
  sleep 2
done
[[ "$READY" == 1 ]] || { echo 'Knowledge Hub health failed; rolling back' >&2; false; }
docker exec obsidian-knowledge-hub node --input-type=module -e '
 const m=await import("/hub/controlled-write-runtime.mjs");
 for (const name of ["download_attachment_from_url","get_image_metadata","list_image_attachments"]) {
   if (!m.controlledWriteToolNames.has(name) || !m.controlledWriteTools.some(x=>x.name===name)) process.exit(19);
 }
' >/dev/null
[[ "$(note_hash)" == "$BEFORE" ]] || { echo 'Existing note read changed after restart' >&2; false; }

echo '5/5 Installation checks passed.'
trap - ERR
rm -rf -- "$TMP"
echo 'SUCCESS: Obsidian Knowledge Hub now advertises download_attachment_from_url, list_image_attachments, get_image_metadata.'
echo 'NEXT: refresh the connected Obsidian Knowledge Hub tool list in ChatGPT, then request the desired banner.'
