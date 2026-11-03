# scripts/resume/ — résumé tooling

- `tailor-resume.mjs` — reorders/emphasises a base content JSON per JD. Never invents a skill.
- `build-resume.mjs` — fills `templates/cv-template.html` from a content JSON → HTML.
- `build-resume-docx.mjs` — the same content as a `.docx` (some portals and recruiters insist).
- `ats-check.mjs` — ATS % match of a CV JSON against a JD.
- `gen-pass-pdfs.mjs` — batch résumé PDFs for the jobs that cleared the gate, deduped per
  company per day. Off by default in the automation; run it by hand when you want the PDFs.
- `make-cover-letter.mjs` — cover letter (`.txt` + `.pdf`) from your master markdown. Name,
  email and phone come from `config/profile.json`.

PDF rendering goes through `generate-pdf.mjs` at the repo root.
