# Papers

Checked-in copies of the sources this tool reasons from, so the argument stays
inspectable after a URL rots. Regenerate the annotated bibliography with
`node scripts/gen-docs.js`.

| File | Source | Why it is here |
|---|---|---|
| `nist-ai-600-1-genai-profile.pdf` | NIST AI 600-1 (2024) | 13 generative-AI risks, ~400 suggested actions. The risk register behind `governance`, `data`, and `evaluation`. |
| `owasp-top10-llm-2025-genai.pdf` | OWASP Top 10 for LLM Apps 2025 | LLM06 Excessive Agency — excessive functionality, permissions, autonomy. |
| `owasp-top10-agentic-apps-2026.pdf` | OWASP Top 10 for Agentic Apps 2026 | Extends LLM06 to multi-step plans and delegation chains. Action budgets, egress allowlists, intent gates. |
| `sandbox-escape-bench-2603.02277.pdf` | UK AISI / Oxford (2026) | Frontier models escape misconfigured containers reliably. Justifies treating Docker as packaging. |
| `tau-bench-2406.12045.pdf` | Sierra (2024) | Introduces `pass^k`. Strong agents drop below 25% at k=8. |
| `agent-eval-survey-2507.21504.pdf` | arXiv (2025) | Map of the evaluation space: task performance, reliability, safety, efficiency, trajectory quality. |
| `saber-coding-agent-safety-2606.01317.pdf` | arXiv (2026) | Best model: 31% safe completion across 716 tasks. Judge the end state, not the refusal. |
| `procedure-aware-eval-2603.03116.pdf` | arXiv (2026) | 27–78% of reported benchmark successes are "corrupt" — right outcome, violated procedure. |
| `consistency-testable-property-2605.10516.pdf` | arXiv (2026) | Splits drift into composition vs ordering. Accuracy hides both. |
| `ai-agents-humans-out-of-loop-2608.23642.pdf` | Mitchell, Hugging Face (2026) | Approval fatigue and skill atrophy are design outcomes, not user failures. |
| `google-secure-ai-agents-2502.17832.pdf` | Google (2025) | Well-defined human controllers, carefully limited powers, observable planning. |

Local copies are for reference and reading. Each work remains under its own
licence; NIST and OWASP material is public, the arXiv papers are under the
licences stated on their abstract pages.
