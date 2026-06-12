---
name: project-temp-medicao
description: Sistema de Medição de Temperatura para Câmara Fria — app web single-page
metadata:
  type: project
---

Projeto: aplicativo web de monitoramento de temperatura para câmara fria.

Arquivos principais:
- index.html — estrutura da interface
- style.css — tema escuro (dark mode), variáveis CSS
- app.js — lógica de simulação, Chart.js, alertas, exportação CSV

**Why:** Usuário pediu um app de medição de temperatura de câmara fria; implementado como SPA web para não exigir instalação.

**How to apply:** Se o usuário quiser integrar sensor real, o ponto de entrada é a função `simulateTemp()` em app.js — substituí-la por uma chamada HTTP/WebSocket/Serial é o único lugar a mudar.
