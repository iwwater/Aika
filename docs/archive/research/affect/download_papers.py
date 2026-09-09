"""Download public research PDFs; preserve originals and record reproducibility metadata."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import io
import json
import subprocess
from urllib.request import urlopen, Request
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent
PAPERS = [
    ('01_dynamic_persona_coherence', 'Beyond Static Persona Consistency: Dynamic Persona Coherence in LLM Role-Playing', 'ACL 2026', 'https://aclanthology.org/2026.acl-long.1336/', 'https://aclanthology.org/2026.acl-long.1336.pdf'),
    ('02_zifamem', 'ZifaMem: Structured Memory for Persona, Preference, and Emotional Continuity in AI Companions', 'arXiv preprint', 'https://arxiv.org/abs/2607.17564', 'https://arxiv.org/pdf/2607.17564'),
    ('03_explicit_state_dynamics', 'Controlling Long-Horizon Behavior in Language Model Agents with Explicit State Dynamics', 'arXiv preprint', 'https://arxiv.org/abs/2601.16087', 'https://arxiv.org/pdf/2601.16087'),
    ('04_triggers_to_emotions', 'From Triggers to Emotions: A CPM-Grounded Appraisal Multi-Agent for Dynamic Emotional Evolution in Persona-Based Dialogue', 'arXiv preprint', 'https://arxiv.org/abs/2607.07824', 'https://arxiv.org/pdf/2607.07824'),
    ('05_appraisal_affect_flow', 'An Appraisal Theoretic Approach to Modelling Affect Flow in Conversation Corpora', 'CoNLL 2025', 'https://aclanthology.org/2025.conll-1.16/', 'https://aclanthology.org/2025.conll-1.16.pdf'),
    ('06_emobench', 'EmoBench: Evaluating the Emotional Intelligence of Large Language Models', 'ACL 2024', 'https://aclanthology.org/2024.acl-long.326/', 'https://aclanthology.org/2024.acl-long.326.pdf'),
    ('07_personallm', 'PersonaLLM: Investigating the Ability of Large Language Models to Express Personality Traits', 'Findings of NAACL 2024', 'https://aclanthology.org/2024.findings-naacl.229/', 'https://aclanthology.org/2024.findings-naacl.229.pdf'),
    ('08_psychometric_personality', 'A psychometric framework for evaluating and shaping personality traits in large language models', 'Nature Machine Intelligence 2025', 'https://www.nature.com/articles/s42256-025-01115-6', 'https://www.nature.com/articles/s42256-025-01115-6.pdf'),
    ('09_locomo', 'Evaluating Very Long-Term Conversational Memory of LLM Agents', 'ACL 2024', 'https://aclanthology.org/2024.acl-long.747/', 'https://aclanthology.org/2024.acl-long.747.pdf'),
    ('10_persona_contrastive_learning', 'Enhancing Persona Consistency for LLMs’ Role-Playing using Persona-Aware Contrastive Learning', 'Findings of ACL 2025', 'https://aclanthology.org/2025.findings-acl.1344/', 'https://aclanthology.org/2025.findings-acl.1344.pdf'),
    ('11_persona_event_emotion', 'Persona-E2: A Human-Grounded Dataset for Personality-Shaped Emotional Responses to Textual Events', 'ACL 2026', 'https://aclanthology.org/2026.acl-long.1350/', 'https://aclanthology.org/2026.acl-long.1350.pdf'),
    ('12_meld', 'MELD: A Multimodal Multi-Party Dataset for Emotion Recognition in Conversations', 'ACL 2019', 'https://aclanthology.org/P19-1050/', 'https://aclanthology.org/P19-1050.pdf'),
]

def download(paper):
    key, title, publication, source, url = paper
    row = dict(id=key, title=title, publication=publication, source_url=source, requested_pdf_url=url)
    target = ROOT / 'papers' / (key + '.pdf')
    try:
        if target.exists():
            data = target.read_bytes()
            row['retrieval'] = 'existing local file'
        else:
            try:
                with urlopen(Request(url, headers={'User-Agent': 'AikaResearchArchive/1.0'}), timeout=45) as response:
                    data = response.read()
                    row.update(final_url=response.url, retrieved_at=datetime.now(timezone.utc).isoformat())
            except OSError as error:
                if 'CERTIFICATE_VERIFY_FAILED' not in str(error):
                    raise
                # Windows curl uses the system certificate store; TLS verification stays on.
                result = subprocess.run(['curl.exe', '--fail', '--location', '--silent', '--show-error', '--max-time', '50', url], capture_output=True, check=True)
                data = result.stdout
                row.update(retrieved_at=datetime.now(timezone.utc).isoformat(), transport='system curl with TLS verification')
        if not data.startswith(b'%PDF-'):
            raise ValueError('Response is not a PDF')
        reader = PdfReader(io.BytesIO(data))
        first = reader.pages[0].extract_text() or ''
        if not first.strip():
            raise ValueError('No extractable first-page text')
        if not target.exists():
            target.write_bytes(data)
        row.update(status='verified_pdf', file='papers/' + target.name, pages=len(reader.pages), bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), first_page_excerpt=first[:700])
    except Exception as error:
        row.update(status='failed', error=str(error))
    print(json.dumps({k: row[k] for k in ('id','status','pages','error') if k in row}, ensure_ascii=False), flush=True)
    return row

if __name__ == '__main__':
    (ROOT / 'papers').mkdir(parents=True, exist_ok=True)
    old_path = ROOT / 'manifest.json'
    old_rows = {r['id']: r for r in json.loads(old_path.read_text(encoding='utf-8'))} if old_path.exists() else {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(download, PAPERS))
    for row in rows:
        old = old_rows.get(row['id'], {})
        if row.get('sha256') == old.get('sha256'):
            for key in ('retrieved_at', 'final_url'):
                if key in old:
                    row[key] = old[key]
    old_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding='utf-8')
