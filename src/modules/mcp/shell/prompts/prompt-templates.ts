/**
 * MCP Prompt Templates
 *
 * Pre-built analysis workflows for common budget investigation scenarios.
 * Each prompt provides structured guidance for multi-step analysis.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Argument Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const EntityHealthCheckArgsSchema = z.object({
  cui: z.string().describe('CUI (fiscal code) of the entity to analyze'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .describe('Year to analyze (e.g., "2023")'),
});

export const PeerComparisonArgsSchema = z.object({
  cui: z.string().describe('CUI of the entity to compare'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .describe('Year to analyze'),
  peerCuis: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe('List of peer entity CUIs to compare against (1-10 entities)'),
});

export const OutlierDetectionArgsSchema = z.object({
  classificationCode: z.string().describe('Functional or economic classification code'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .describe('Year to analyze'),
  uatId: z.number().optional().describe('Optional: Filter by UAT (county/locality)'),
});

export const TrendTrackingArgsSchema = z.object({
  cui: z.string().describe('CUI of the entity to track'),
  startYear: z
    .string()
    .regex(/^\d{4}$/)
    .describe('Start year (e.g., "2020")'),
  endYear: z
    .string()
    .regex(/^\d{4}$/)
    .describe('End year (e.g., "2023")'),
  focusArea: z.string().optional().describe('Optional: Specific classification code to focus on'),
});

export const DeepDiveArgsSchema = z.object({
  cui: z.string().describe('CUI of the entity to investigate'),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .describe('Year to investigate'),
  classificationCode: z
    .string()
    .optional()
    .describe('Optional: Specific classification code to investigate'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Templates
// ─────────────────────────────────────────────────────────────────────────────

export const ENTITY_HEALTH_CHECK_PROMPT = {
  name: 'entity-health-check',
  description:
    'Comprehensive health check analysis of a public entity: budget execution, efficiency, and anomalies',
  arguments: EntityHealthCheckArgsSchema,
  template: (args: z.infer<typeof EntityHealthCheckArgsSchema>) => `
# Verificare Sănătate Entitate: ${args.cui} (${args.year})

Efectuează o analiză completă a sănătății financiare a entității **${args.cui}** pentru anul **${args.year}**.

## Obiectiv
Identifică:
- Rata de execuție bugetară (plăți vs. angajamente)
- Eficiența cheltuielilor (comparație cu entități similare)
- Anomalii sau valori atipice în execuție
- Tendințe îngrijorătoare sau pozitive

## Pași de Urmat

### 1. Obține Informații de Bază despre Entitate
\`\`\`
Tool: get_entity_info
Parametri: { cui: "${args.cui}" }
\`\`\`

**Analizează:**
- Tipul entității (primărie, spital, școală, etc.)
- UAT-ul de apartenență
- Dacă este UAT (unitate administrativ-teritorială)

### 2. Obține Execuția Bugetară Anuală
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" }
}
\`\`\`

**Calculează și raportează:**
- **Rata de execuție plăți**: (total_payments / total_budget) × 100
- **Rata de execuție angajamente**: (total_commitments / total_budget) × 100
- **Diferența plăți-angajamente**: total_commitments - total_payments
- **Interpretare**:
  - Sub 80% plăți = execuție slabă, posibile probleme de capacitate
  - 80-95% = execuție bună
  - Peste 95% = execuție excelentă
  - Angajamente >> Plăți = restanțe mari

### 3. Analizează Distribuția pe Clasificație Funcțională
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "functional_classification"
}
\`\`\`

**Identifică:**
- Top 5 capitole funcționale după plăți
- Capitole cu execuție sub 70% (posibile probleme)
- Capitole cu execuție peste 98% (posibilă subestimare buget)

### 4. Analizează Distribuția pe Clasificație Economică
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "economic_classification"
}
\`\`\`

**Verifică:**
- Proporția cheltuieli curente vs. capitale
- Cheltuieli de personal (cod 10.xx.xx) - ar trebui 40-60% din total
- Investiții (cod 71.xx.xx) - verifică dacă există proiecte majore
- Cheltuieli cu bunuri și servicii (cod 20.xx.xx)

### 5. Compară cu Entități Similare (Peer Comparison)
\`\`\`
Tool: get_aggregated_execution
Parametri: {
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    entityType: "<tipul entității din pasul 1>",
    uatId: <uat_id din pasul 1, dacă există>
  }
}
\`\`\`

**Compară:**
- Bugetul entității cu media peer-ilor
- Rata de execuție cu media peer-ilor
- Identifică dacă entitatea este outlier (>2 deviații standard)

### 6. Verifică Evoluția Lunară (Identifică Anomalii)
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "month"
}
\`\`\`

**Caută:**
- Luni cu plăți anormal de mari (>20% din total anual)
- Luni fără plăți (posibile erori de raportare)
- Concentrare în decembrie (>30% = posibilă grabă de execuție)

## Format Raport Final

### Rezumat Executiv
- Starea generală: 🟢 Sănătoasă / 🟡 Atenție / 🔴 Problematică
- Rata de execuție: X%
- Poziție față de peer-i: peste/sub medie

### Indicatori Cheie
| Indicator | Valoare | Interpretare |
|-----------|---------|--------------|
| Buget total | X RON | ... |
| Plăți totale | X RON | ... |
| Rata execuție | X% | ... |
| Restanțe (angajamente - plăți) | X RON | ... |

### Distribuție Cheltuieli
- Top 3 capitole funcționale
- Top 3 capitole economice

### Anomalii Identificate
- Lista anomaliilor cu severitate (🔴 critică, 🟡 atenție)

### Recomandări
- Acțiuni sugerate pentru îmbunătățire

### Link Partajabil
- Include link-ul din răspunsul tool-ului pentru vizualizare interactivă

---

**IMPORTANT:**
- Toate valorile monetare în format: 1,234,567.89 RON
- Procente cu 2 zecimale: 85.67%
- Interpretează în context (tipul entității, dimensiunea UAT-ului)
- Compară întotdeauna cu peer-i relevanți
`,
};

export const PEER_COMPARISON_PROMPT = {
  name: 'peer-comparison',
  description:
    'Compare budget execution of an entity against similar peers to identify performance gaps',
  arguments: PeerComparisonArgsSchema,
  template: (args: z.infer<typeof PeerComparisonArgsSchema>) => `
# Comparație cu Entități Similare: ${args.cui} vs. ${String(args.peerCuis.length)} Peer-i (${args.year})

Compară performanța bugetară a entității **${args.cui}** cu ${String(args.peerCuis.length)} entități similare pentru anul **${args.year}**.

## Obiectiv
Identifică:
- Diferențe de eficiență în execuția bugetară
- Best practices de la peer-ii cu performanță superioară
- Oportunități de îmbunătățire
- Anomalii sau valori atipice

## Pași de Urmat

### 1. Obține Date pentru Entitatea Țintă
\`\`\`
Tool: get_entity_info
Parametri: { cui: "${args.cui}" }
\`\`\`

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" }
}
\`\`\`

**Extrage:**
- Nume entitate, tip, UAT
- Buget total, plăți totale, angajamente totale
- Rata de execuție

### 2. Obține Date pentru Fiecare Peer
Pentru fiecare CUI din lista: ${args.peerCuis.map((cui) => `"${cui}"`).join(', ')}

\`\`\`
Tool: get_entity_info
Parametri: { cui: "<peer_cui>" }
\`\`\`

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "<peer_cui>",
  period: { type: "YEAR", value: "${args.year}" }
}
\`\`\`

**Creează tabel comparativ:**
| Entitate | Tip | UAT | Buget | Plăți | Rata Execuție |
|----------|-----|-----|-------|-------|---------------|
| ${args.cui} (ȚINTĂ) | ... | ... | ... | ... | ... |
| Peer 1 | ... | ... | ... | ... | ... |
| ... | ... | ... | ... | ... | ... |

### 3. Analiză Statistică

**Calculează pentru grup:**
- Media bugetului: Σ(bugete) / n
- Media ratei de execuție: Σ(rate) / n
- Deviația standard pentru buget și rată execuție
- Mediana ratei de execuție

**Poziționează entitatea țintă:**
- Percentila bugetului (e.g., "top 25%" sau "bottom 50%")
- Percentila ratei de execuție
- Număr de deviații standard față de medie (Z-score)

### 4. Comparație pe Clasificație Funcțională

Pentru entitatea țintă și top 3 peer-i după rată de execuție:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "<cui>",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "functional_classification"
}
\`\`\`

**Compară:**
- Distribuția procentuală pe capitole funcționale
- Identifică capitole unde ținta este sub-performantă
- Identifică capitole unde ținta excelează

**Exemplu tabel:**
| Capitol | Țintă % | Peer 1 % | Peer 2 % | Peer 3 % | Medie Peer |
|---------|---------|----------|----------|----------|------------|
| 01.xx.xx (Servicii publice generale) | 15% | 12% | 14% | 13% | 13% |
| ... | ... | ... | ... | ... | ... |

### 5. Comparație pe Clasificație Economică

Similar cu pasul 4, dar pentru clasificația economică:

**Focus pe:**
- Cheltuieli de personal (10.xx.xx) - compară % din total
- Cheltuieli cu bunuri și servicii (20.xx.xx)
- Investiții (71.xx.xx)
- Alte cheltuieli (50.xx.xx, 59.xx.xx)

### 6. Identifică Best Practices

**Pentru peer-ii cu cele mai bune rate de execuție:**
- Ce fac diferit?
- Au bugete mai realiste?
- Au capacitate administrativă superioară?
- Au proiecte mai bine planificate?

**Analizează evoluția lunară pentru top performer:**
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "<top_peer_cui>",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "month"
}
\`\`\`

Compară cu evoluția lunară a entității țintă.

## Format Raport Final

### Rezumat Executiv
- Poziția entității: X/Y (e.g., "3 din 6 entități")
- Performanță relativă: peste/sub medie cu X puncte procentuale
- Verdict: 🟢 Performanță superioară / 🟡 Performanță medie / 🔴 Sub-performanță

### Tabel Comparativ General
| Metric | Țintă | Medie Peer | Cel Mai Bun | Cel Mai Slab |
|--------|-------|------------|-------------|--------------|
| Buget | ... | ... | ... | ... |
| Plăți | ... | ... | ... | ... |
| Rata execuție | ... | ... | ... | ... |
| Restanțe | ... | ... | ... | ... |

### Analiză Gap-uri
**Unde entitatea țintă rămâne în urmă:**
- Capitol/categorie X: sub medie cu Y puncte procentuale
- Posibile cauze: ...
- Recomandări: ...

**Unde entitatea țintă excelează:**
- Capitol/categorie Z: peste medie cu W puncte procentuale
- Ce face bine: ...

### Best Practices Identificate
- Practică 1 de la Peer X: ...
- Practică 2 de la Peer Y: ...

### Recomandări Acționabile
1. **Prioritate înaltă**: ...
2. **Prioritate medie**: ...
3. **Monitorizare**: ...

### Link-uri Partajabile
- Entitate țintă: [link]
- Top performer: [link]

---

**IMPORTANT:**
- Compară doar entități comparabile (același tip, dimensiune similară)
- Contextualizează diferențele (UAT bogat vs. sărac, urban vs. rural)
- Nu trage concluzii pripite - verifică datele pentru anomalii
`,
};

export const OUTLIER_DETECTION_PROMPT = {
  name: 'outlier-detection',
  description:
    'Detect entities with unusual budget execution patterns for a specific classification code',
  arguments: OutlierDetectionArgsSchema,
  template: (args: z.infer<typeof OutlierDetectionArgsSchema>) => `
# Detectare Valori Atipice: Cod ${args.classificationCode} (${args.year})

Identifică entități cu execuție bugetară neobișnuită pentru codul de clasificare **${args.classificationCode}** în anul **${args.year}**.

## Obiectiv
Găsește entități care:
- Cheltuiesc semnificativ mai mult/puțin decât media
- Au rate de execuție anormal de mari sau mici
- Prezintă pattern-uri suspecte de execuție

## Pași de Urmat

### 1. Obține Execuția Agregată pentru Cod
\`\`\`
Tool: get_aggregated_execution
Parametri: {
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    classificationCode: "${args.classificationCode}"${args.uatId !== undefined ? `,\n    uatId: ${String(args.uatId)}` : ''}
  },
  groupBy: "entity"
}
\`\`\`

**Extrage:**
- Lista tuturor entităților cu cheltuieli pe acest cod
- Pentru fiecare: CUI, buget, plăți, angajamente, rata execuție

### 2. Calculează Statistici Descriptive

**Pentru buget:**
- Media: μ = Σ(bugete) / n
- Deviația standard: σ
- Mediana
- Q1 (percentila 25), Q3 (percentila 75)
- IQR (Interquartile Range) = Q3 - Q1

**Pentru rata de execuție:**
- Media ratelor de execuție
- Deviația standard
- Mediana

### 3. Identifică Outlier-i Statistici

**Metoda 1: Z-Score (Deviații Standard)**
Pentru fiecare entitate, calculează:
- Z-score buget = (buget_entitate - μ) / σ
- Z-score rată = (rată_entitate - μ_rată) / σ_rată

**Clasificare:**
- |Z| > 3: Outlier extrem 🔴
- 2 < |Z| ≤ 3: Outlier moderat 🟡
- |Z| ≤ 2: Normal 🟢

**Metoda 2: IQR (Interquartile Range)**
- Outlier superior: buget > Q3 + 1.5 × IQR
- Outlier inferior: buget < Q1 - 1.5 × IQR

### 4. Analizează Top Outlier-i

Pentru top 5 outlier-i după Z-score (cei mai extremi):

\`\`\`
Tool: get_entity_info
Parametri: { cui: "<outlier_cui>" }
\`\`\`

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "<outlier_cui>",
  period: { type: "YEAR", value: "${args.year}" }
}
\`\`\`

**Investighează:**
- Tipul entității (e.g., spital mare vs. dispensar rural)
- Dimensiunea UAT-ului (populație, buget total)
- Context care explică valoarea atipică

### 5. Verifică Pattern-uri Temporale Suspecte

Pentru outlier-ii cu Z > 2, analizează evoluția lunară:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "<outlier_cui>",
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    classificationCode: "${args.classificationCode}"
  },
  groupBy: "month"
}
\`\`\`

**Red flags:**
- >50% din plăți într-o singură lună
- Luni consecutive fără plăți, apoi plată masivă
- Plăți în decembrie >40% din total anual

### 6. Compară cu Anul Anterior (Dacă Disponibil)

Pentru outlier-ii extremi, verifică dacă pattern-ul este consistent:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "<outlier_cui>",
  period: { type: "YEAR", value: "${String(parseInt(args.year) - 1)}" },
  filters: {
    classificationCode: "${args.classificationCode}"
  }
}
\`\`\`

**Analizează:**
- Dacă entitatea a fost outlier și anul trecut → pattern consistent
- Dacă e nou outlier → investigație necesară

## Format Raport Final

### Rezumat Executiv
- Cod analizat: ${args.classificationCode} (nume clasificare)
- Număr entități analizate: X
- Outlier-i identificați: Y (Z% din total)
- Severitate: 🔴 X extremi, 🟡 Y moderați

### Statistici Grup
| Metric | Valoare |
|--------|---------|
| Buget total (toate entitățile) | X RON |
| Buget mediu per entitate | X RON |
| Deviație standard | X RON |
| Mediana | X RON |
| Rata medie de execuție | X% |

### Top 10 Outlier-i (Buget)

| Rank | CUI | Entitate | Buget | Z-Score | Rată Exec | Severitate | Context |
|------|-----|----------|-------|---------|-----------|------------|---------|
| 1 | ... | ... | ... | +4.2 | 95% | 🔴 Extrem | Spital județean |
| 2 | ... | ... | ... | +3.1 | 78% | 🔴 Extrem | Primărie municipiu |
| ... | ... | ... | ... | ... | ... | ... | ... |

### Outlier-i cu Pattern-uri Suspecte

**Entitate X (CUI: ...)**
- Z-score: +3.5
- Red flag: 65% din plăți în decembrie
- Recomandare: Investigație pentru posibilă execuție artificială

**Entitate Y (CUI: ...)**
- Z-score: -2.8 (sub medie)
- Red flag: Rată execuție 15% (foarte scăzută)
- Recomandare: Verificare capacitate administrativă

### Outlier-i Justificați (Context Valid)

**Entitate Z (CUI: ...)**
- Z-score: +4.0
- Justificare: Spital regional cu 1,200 paturi
- Concluzie: Outlier normal, dimensiune instituție

### Recomandări de Investigație

**Prioritate înaltă (🔴):**
1. Entitate A - pattern suspect + Z > 3
2. Entitate B - rată execuție anormală

**Monitorizare (🟡):**
1. Entitate C - outlier moderat, verificare anul viitor
2. Entitate D - creștere bruscă față de anul anterior

### Link-uri Partajabile
- Top outlier: [link]
- Outlier suspect 1: [link]
- Outlier suspect 2: [link]

---

**IMPORTANT:**
- Outlier ≠ fraudă automată. Multe outlier-i au explicații valide.
- Contextualizează: spital mare vs. dispensar, municipiu vs. comună
- Verifică calitatea datelor înainte de a trage concluzii
- Focus pe pattern-uri + valori extreme, nu doar valori mari
`,
};

export const TREND_TRACKING_PROMPT = {
  name: 'trend-tracking',
  description: 'Track budget execution trends for an entity over multiple years',
  arguments: TrendTrackingArgsSchema,
  template: (args: z.infer<typeof TrendTrackingArgsSchema>) => `
# Urmărire Tendințe: ${args.cui} (${args.startYear}-${args.endYear})

Analizează evoluția execuției bugetare a entității **${args.cui}** pe perioada **${args.startYear}-${args.endYear}**.

## Obiectiv
Identifică:
- Tendințe de creștere/descreștere în buget și execuție
- Schimbări în prioritățile de cheltuieli
- Îmbunătățiri sau deteriorări în eficiența execuției
- Anomalii sau evenimente neobișnuite

## Pași de Urmat

### 1. Obține Informații de Bază despre Entitate
\`\`\`
Tool: get_entity_info
Parametri: { cui: "${args.cui}" }
\`\`\`

**Notează:**
- Nume, tip entitate, UAT
- Context pentru interpretarea tendințelor

### 2. Obține Execuția pentru Fiecare An

Pentru fiecare an din ${args.startYear} până în ${args.endYear}:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "<year>" }${args.focusArea !== undefined ? `,\n  filters: { classificationCode: "${args.focusArea}" }` : ''}
}
\`\`\`

**Creează tabel temporal:**
| An | Buget | Plăți | Angajamente | Rată Exec | Restanțe |
|----|-------|-------|-------------|-----------|----------|
| ${args.startYear} | ... | ... | ... | ...% | ... |
| ${String(parseInt(args.startYear) + 1)} | ... | ... | ... | ...% | ... |
| ... | ... | ... | ... | ...% | ... |
| ${args.endYear} | ... | ... | ... | ...% | ... |

### 3. Calculează Indicatori de Tendință

**Creștere/Descreștere Anuală:**
Pentru fiecare an i (față de anul i-1):
- Δ Buget = (Buget_i - Buget_{i-1}) / Buget_{i-1} × 100
- Δ Plăți = (Plăți_i - Plăți_{i-1}) / Plăți_{i-1} × 100
- Δ Rată Exec = Rată_i - Rată_{i-1} (puncte procentuale)

**Creștere Totală (Perioada Completă):**
- CAGR Buget = [(Buget_final / Buget_inițial)^(1/n) - 1] × 100
  - n = număr ani - 1
- CAGR Plăți = similar

**Volatilitate:**
- Deviația standard a ratei de execuție
- Coeficient de variație = (σ / μ) × 100

### 4. Analizează Tendințe pe Clasificație Funcțională

Pentru fiecare an, obține distribuția pe clasificație funcțională:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "<year>" },
  groupBy: "functional_classification"
}
\`\`\`

**Identifică:**
- Capitole cu creștere constantă (prioritate crescândă)
- Capitole cu descreștere constantă (prioritate descrescândă)
- Capitole cu volatilitate mare (instabilitate)

**Exemplu tabel:**
| Capitol | ${args.startYear} % | ${String(parseInt(args.startYear) + 1)} % | ... | ${args.endYear} % | Tendință |
|---------|---------|---------|-----|---------|----------|
| 01.xx.xx | 15% | 16% | ... | 18% | ↗️ +3pp |
| 04.xx.xx | 25% | 23% | ... | 20% | ↘️ -5pp |
| ... | ... | ... | ... | ... | ... |

### 5. Analizează Tendințe pe Clasificație Economică

Similar cu pasul 4, pentru clasificația economică:

**Focus pe:**
- Cheltuieli de personal (10.xx.xx) - tendință % din total
- Investiții (71.xx.xx) - identifică ani cu proiecte majore
- Cheltuieli cu bunuri și servicii (20.xx.xx)

### 6. Identifică Evenimente și Anomalii

**Caută:**
- Ani cu schimbări bruște (>30% creștere/descreștere)
- Ani cu rată de execuție anormal de scăzută (<70%)
- Ani cu restanțe mari (angajamente >> plăți)

**Pentru fiecare anomalie, investighează:**
- Context: alegeri locale, proiecte mari, criză economică?
- Persistență: s-a corectat anul următor?

### 7. Compară cu Tendințe Naționale/Regionale (Dacă Relevant)

Obține date agregate pentru entități similare:

\`\`\`
Tool: get_aggregated_execution
Parametri: {
  period: { type: "YEAR", value: "<year>" },
  filters: {
    entityType: "<tipul entității>",
    uatId: <uat_id, dacă relevant>
  }
}
\`\`\`

**Compară:**
- Entitatea crește mai rapid/lent decât peer-ii?
- Rata de execuție îmbunătățită mai mult/puțin decât media?

## Format Raport Final

### Rezumat Executiv
- Perioada analizată: ${args.startYear}-${args.endYear} (${String(parseInt(args.endYear) - parseInt(args.startYear) + 1)} ani)
- Tendință generală: 📈 Creștere / 📉 Descreștere / ➡️ Stabilitate
- Eficiență execuție: 📈 Îmbunătățire / 📉 Deteriorare / ➡️ Constantă

### Indicatori Cheie - Evoluție

| Indicator | ${args.startYear} | ${args.endYear} | Δ Total | CAGR |
|-----------|---------|---------|---------|------|
| Buget | X RON | Y RON | +Z% | +W% |
| Plăți | X RON | Y RON | +Z% | +W% |
| Rată execuție | X% | Y% | +Zpp | - |
| Restanțe | X RON | Y RON | +Z% | +W% |

### Grafic Tendințe (Descriere)
**Buget și Plăți (${args.startYear}-${args.endYear}):**
- Linie 1: Buget (albastru)
- Linie 2: Plăți (verde)
- Observații: [descrie pattern-ul vizual]

**Rată de Execuție (${args.startYear}-${args.endYear}):**
- Linie: Rată execuție (%)
- Observații: [descrie pattern-ul]

### Schimbări în Priorități (Top 5 Capitole)

**Capitole cu Creștere:**
1. Capitol X: de la Y% (${args.startYear}) la Z% (${args.endYear}) - +Wpp
   - Interpretare: ...

**Capitole cu Descreștere:**
1. Capitol A: de la B% (${args.startYear}) la C% (${args.endYear}) - -Dpp
   - Interpretare: ...

### Evenimente și Anomalii Identificate

**${String(parseInt(args.startYear) + 1)}:**
- Anomalie: Creștere bruscă buget cu 45%
- Context posibil: Proiect european major, fuziune entități
- Impact: ...

**${String(parseInt(args.startYear) + 2)}:**
- Anomalie: Rată execuție 62% (cea mai scăzută)
- Context posibil: Schimbare management, criză COVID
- Recuperare: Anul următor îmbunătățire la 85%

### Comparație cu Peer-i

| Metric | Entitate | Medie Peer | Poziție |
|--------|----------|------------|---------|
| CAGR Buget | +X% | +Y% | Peste/Sub medie |
| Îmbunătățire rată exec | +Xpp | +Ypp | Peste/Sub medie |

### Predicții și Recomandări

**Dacă tendința continuă:**
- Buget ${String(parseInt(args.endYear) + 1)} estimat: X RON
- Rată execuție ${String(parseInt(args.endYear) + 1)} estimată: Y%

**Recomandări:**
1. **Dacă tendință pozitivă**: Menține best practices, monitorizează sustenabilitate
2. **Dacă tendință negativă**: Investigație urgentă, plan de remediere
3. **Dacă volatilitate mare**: Îmbunătățire planificare bugetară

### Link-uri Partajabile
- Execuție ${args.startYear}: [link]
- Execuție ${args.endYear}: [link]
${args.focusArea !== undefined ? `- Focus ${args.focusArea}: [link]` : ''}

---

**IMPORTANT:**
- Contextualizează tendințele (criză COVID, inflație, proiecte UE)
- Verifică consistența datelor între ani
- Atenție la schimbări metodologice de raportare
- Compară cu tendințe macro (inflație, creștere PIB)
`,
};

export const DEEP_DIVE_PROMPT = {
  name: 'deep-dive-investigation',
  description: 'Comprehensive deep-dive investigation of an entity with drill-down analysis',
  arguments: DeepDiveArgsSchema,
  template: (args: z.infer<typeof DeepDiveArgsSchema>) => `
# Investigație Aprofundată: ${args.cui} (${args.year})

Investigație completă și detaliată a entității **${args.cui}** pentru anul **${args.year}**${args.classificationCode !== undefined ? ` cu focus pe codul **${args.classificationCode}**` : ''}.

## Obiectiv
Analiză exhaustivă pe mai multe niveluri:
- Nivel 1: Panoramă generală (entitate, buget total)
- Nivel 2: Distribuție pe clasificații (funcțională, economică)
- Nivel 3: Drill-down pe coduri specifice
- Nivel 4: Evoluție temporală (lunară, trimestrială)
- Nivel 5: Context comparativ (peer-i, tendințe)

## Pași de Urmat

### NIVEL 1: Panoramă Generală

#### 1.1 Profil Entitate
\`\`\`
Tool: get_entity_info
Parametri: { cui: "${args.cui}" }
\`\`\`

**Documentează:**
- Nume complet, tip entitate
- UAT de apartenență (județ, localitate)
- Dacă este UAT (primărie, consiliu județean)
- Adresă, date de contact

#### 1.2 Execuție Bugetară Anuală
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" }
}
\`\`\`

**Analizează:**
- Buget total, plăți totale, angajamente totale
- Rata de execuție plăți și angajamente
- Restanțe (angajamente - plăți)
- Evaluare inițială: 🟢/🟡/🔴

### NIVEL 2: Distribuție pe Clasificații

#### 2.1 Clasificare Funcțională (COFOG)
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "functional_classification"
}
\`\`\`

**Creează tabel:**
| Capitol | Cod | Buget | Plăți | Rată Exec | % din Total |
|---------|-----|-------|-------|-----------|-------------|
| Servicii publice generale | 01.xx.xx | ... | ... | ...% | ...% |
| Apărare | 02.xx.xx | ... | ... | ...% | ...% |
| ... | ... | ... | ... | ...% | ...% |

**Identifică:**
- Top 5 capitole după buget
- Capitole cu execuție <70% (problematice)
- Capitole cu execuție >95% (eficiente)

#### 2.2 Clasificare Economică
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "economic_classification"
}
\`\`\`

**Analizează structura:**
- Cheltuieli curente vs. capitale
- Cheltuieli de personal (10.xx.xx) - % din total
- Bunuri și servicii (20.xx.xx)
- Investiții (71.xx.xx)
- Alte cheltuieli (50.xx.xx, 59.xx.xx, 80.xx.xx)

### NIVEL 3: Drill-Down pe Coduri Specifice

${
  args.classificationCode !== undefined
    ? `
#### 3.1 Focus pe Cod ${args.classificationCode}
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    classificationCode: "${args.classificationCode}"
  }
}
\`\`\`

**Analizează în detaliu:**
- Buget alocat pe acest cod
- Execuție (plăți, angajamente)
- % din bugetul total al entității
- Comparație cu media entităților similare
`
    : `
#### 3.1 Identifică Coduri Problematice
Din analiza Nivel 2, selectează:
- Top 3 coduri cu execuție <70%
- Top 3 coduri cu buget mare (>10% din total)

Pentru fiecare cod, obține detalii:
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    classificationCode: "<cod>"
  }
}
\`\`\`
`
}

#### 3.2 Analiză Încrucișată (Funcțional × Economic)
Pentru codurile identificate la 3.1, obține distribuția economică:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    classificationCode: "<cod_funcțional>"
  },
  groupBy: "economic_classification"
}
\`\`\`

**Exemplu: Capitol 09.xx.xx (Educație)**
| Categorie Economică | Buget | Plăți | % din Capitol |
|---------------------|-------|-------|---------------|
| 10.xx.xx (Personal) | ... | ... | 70% |
| 20.xx.xx (Bunuri/Servicii) | ... | ... | 20% |
| 71.xx.xx (Investiții) | ... | ... | 10% |

### NIVEL 4: Evoluție Temporală

#### 4.1 Evoluție Lunară
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "month"
}
\`\`\`

**Analizează pattern:**
- Distribuție uniformă vs. concentrată
- Identifică luni cu plăți >15% din total (anomalii)
- Verifică decembrie (ar trebui <25% din total)
- Calculează coeficient de variație lunară

**Grafic (descriere):**
- Bare: Plăți lunare
- Linie: Plăți cumulate
- Evidențiază luni atipice

#### 4.2 Evoluție Trimestrială
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  groupBy: "quarter"
}
\`\`\`

**Verifică:**
- Distribuție ideală: ~25% per trimestru
- Identifică trimestre cu sub-execuție (<20%)
- Identifică trimestre cu supra-execuție (>30%)

${
  args.classificationCode !== undefined
    ? `
#### 4.3 Evoluție Lunară pentru Cod ${args.classificationCode}
\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    classificationCode: "${args.classificationCode}"
  },
  groupBy: "month"
}
\`\`\`

**Compară:**
- Pattern lunar pentru acest cod vs. pattern general
- Identifică luni cu concentrare anormală
`
    : ''
}

### NIVEL 5: Context Comparativ

#### 5.1 Comparație cu Entități Similare
\`\`\`
Tool: get_aggregated_execution
Parametri: {
  period: { type: "YEAR", value: "${args.year}" },
  filters: {
    entityType: "<tipul entității din 1.1>",
    uatId: <uat_id din 1.1, dacă relevant>
  }
}
\`\`\`

**Poziționează entitatea:**
- Buget: percentila X din Y entități
- Rată execuție: peste/sub medie cu Z puncte procentuale
- Identifică peer-i relevanți pentru comparație detaliată

#### 5.2 Comparație Detaliată cu Top 3 Peer-i
Pentru fiecare peer identificat la 5.1:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "<peer_cui>",
  period: { type: "YEAR", value: "${args.year}" }
}
\`\`\`

**Tabel comparativ:**
| Metric | Entitate Țintă | Peer 1 | Peer 2 | Peer 3 | Medie Peer |
|--------|----------------|--------|--------|--------|------------|
| Buget | ... | ... | ... | ... | ... |
| Rată exec | ... | ... | ... | ... | ... |
| % Personal | ... | ... | ... | ... | ... |
| % Investiții | ... | ... | ... | ... | ... |

#### 5.3 Tendință Multi-Anuală (Dacă Disponibil)
Pentru anii ${String(parseInt(args.year) - 2)}, ${String(parseInt(args.year) - 1)}, ${args.year}:

\`\`\`
Tool: get_entity_execution
Parametri: {
  cui: "${args.cui}",
  period: { type: "YEAR", value: "<year>" }
}
\`\`\`

**Calculează:**
- CAGR buget (3 ani)
- Evoluție rată de execuție
- Identifică tendințe pozitive/negative

## Format Raport Final

### Rezumat Executiv (1 pagină)
**Entitate:** [Nume] (CUI: ${args.cui})
**Tip:** [Tip entitate] | **UAT:** [Județ, Localitate]
**An analizat:** ${args.year}

**Verdict General:** 🟢 Sănătoasă / 🟡 Atenție / 🔴 Problematică

**Indicatori Cheie:**
| Indicator | Valoare | Evaluare |
|-----------|---------|----------|
| Buget total | X RON | ... |
| Plăți totale | X RON | ... |
| Rată execuție | X% | 🟢/🟡/🔴 |
| Restanțe | X RON | 🟢/🟡/🔴 |
| Poziție vs. peer-i | Top X% | 🟢/🟡/🔴 |

**Top 3 Constatări:**
1. ...
2. ...
3. ...

### Secțiunea 1: Profil și Context
- Informații entitate
- Dimensiune și importanță (buget, populație deservită)
- Comparație cu peer-i

### Secțiunea 2: Execuție Bugetară Generală
- Tabel indicatori cheie
- Grafic buget vs. plăți vs. angajamente
- Analiză rată de execuție

### Secțiunea 3: Distribuție pe Clasificații
- Tabel clasificare funcțională (top 10)
- Tabel clasificare economică (toate categoriile)
- Grafice pie chart (descriere)

### Secțiunea 4: Analiză Detaliată Coduri Specifice
${
  args.classificationCode !== undefined
    ? `- Focus pe cod ${args.classificationCode}`
    : '- Coduri problematice (execuție <70%)'
}
- Coduri cu buget mare (>10% din total)
- Analiză încrucișată funcțional × economic

### Secțiunea 5: Evoluție Temporală
- Grafic evoluție lunară (descriere)
- Tabel evoluție trimestrială
- Identificare anomalii temporale

### Secțiunea 6: Comparație cu Peer-i
- Tabel comparativ detaliat
- Identificare gap-uri de performanță
- Best practices de la peer-i

### Secțiunea 7: Constatări și Recomandări

**Puncte Forte:**
- ✅ Constatare 1
- ✅ Constatare 2

**Puncte Slabe:**
- ❌ Constatare 1
- ❌ Constatare 2

**Riscuri Identificate:**
- ⚠️ Risc 1 (severitate: înaltă/medie/scăzută)
- ⚠️ Risc 2

**Recomandări Acționabile:**
1. **Prioritate înaltă**: ...
2. **Prioritate medie**: ...
3. **Monitorizare**: ...

### Anexe
- Link-uri partajabile pentru toate vizualizările
- Tabele detaliate
- Metodologie de calcul

---

**IMPORTANT:**
- Raport comprehensiv, dar structurat și ușor de navigat
- Folosește vizualizări (descrise) pentru claritate
- Contextualizează toate constatările
- Recomandări concrete, nu generice
- Include link-uri pentru explorare interactivă
`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Export All Prompts
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_PROMPTS = [
  ENTITY_HEALTH_CHECK_PROMPT,
  PEER_COMPARISON_PROMPT,
  OUTLIER_DETECTION_PROMPT,
  TREND_TRACKING_PROMPT,
  DEEP_DIVE_PROMPT,
] as const;
