#!/usr/bin/env python3
"""Structural and known-pattern audit; does not establish asset ownership."""
import hashlib,json,re,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
forbidden_dirs={'.git','node_modules','dist','build','data','artifacts','.local','.cache','__pycache__'}
forbidden_suffixes={'.moc3','.onnx','.sqlite','.db','.webm','.mp4','.wav','.mp3','.wasm','.dylib','.so','.apk','.pkg','.dmg','.p12','.pfx','.pem','.key','.log','.jsonl'}
rules={
 'personal_home':re.compile(rb'/(?:Users|home)/[A-Za-z0-9_.-]+/'),
 'credential':re.compile(rb'\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b'),
 'private_key':re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 'clone_voice':re.compile(rb'Dania(?:Compare|CnHD)[A-Za-z0-9]+'),
 'private_task_id':re.compile(rb'01a0[a-f0-9]{4}-[a-f0-9-]{27,}'),
}
issues=[];manifest=[]
for path in sorted(root.rglob('*')):
 rel=path.relative_to(root)
 if rel.parts[0]=='.git':continue
 if path.is_symlink():issues.append({'path':str(rel),'rule':'symlink'});continue
 if not path.is_file():continue
 if any(p in forbidden_dirs for p in rel.parts) or path.suffix.lower() in forbidden_suffixes or path.name.endswith(('.model3.json','.exp3.json','.motion3.json')):
  issues.append({'path':str(rel),'rule':'excluded_resource'})
 if path.stat().st_size>50*1024*1024:issues.append({'path':str(rel),'rule':'oversized_file'})
 if path.name.startswith('.env') or path.name.startswith(('id_rsa','id_ed25519')):issues.append({'path':str(rel),'rule':'private_config'})
 data=path.read_bytes()
 # This scanner's pattern definitions are intentional, not packaged credentials.
 if path.resolve()!=Path(__file__).resolve():
  for name,pattern in rules.items():
   if pattern.search(data):issues.append({'path':str(rel),'rule':name})
 manifest.append({'path':str(rel),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
print(json.dumps({'ok':not issues,'files':len(manifest),'issues':issues,'manifest':manifest},ensure_ascii=False,indent=2))
sys.exit(bool(issues))
