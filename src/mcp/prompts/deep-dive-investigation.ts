/**
 * MCP Prompt: Deep Dive Investigation
 *
 * Thorough investigation of a specific spending category or budget area.
 * This prompt helps understand the composition, evolution, and patterns
 * of spending in a particular functional or economic category.
 */

export interface DeepDiveInvestigationArgs {
  entity_cui?: string;
  region?: string;
  investigation_focus: string;
  years?: number | number[];
}

export function getDeepDiveInvestigationPrompt(args: DeepDiveInvestigationArgs): string {
  const { entity_cui, region, investigation_focus, years } = args;

  // Determine analysis scope
  let analysisYears: number[];
  if (Array.isArray(years)) {
    analysisYears = years;
  } else if (typeof years === 'number') {
    analysisYears = [years];
  } else {
    analysisYears = [new Date().getFullYear() - 1];
  }

  const isSingleYear = analysisYears.length === 1;
  const isMultiYear = analysisYears.length > 1;
  const yearDisplay = isSingleYear ? analysisYears[0] : `${Math.min(...analysisYears)}-${Math.max(...analysisYears)}`;

  const scope = entity_cui ? `entitate CUI ${entity_cui}` : (region ? `regiunea ${region}` : 'nivel național');

  return `
# Investigație Detaliată - Analiză de Profunzime Bugetară

Ești un expert în audit financiar public și analiză de profunzime. Sarcina ta este să efectuezi o investigație completă și structurată a domeniului **"${investigation_focus}"** pentru **${scope}**, ${isSingleYear ? `anul ${yearDisplay}` : `perioada ${yearDisplay}`}.

## Context investigație

${entity_cui ? `- **Entitate**: CUI ${entity_cui}` : ''}
${region ? `- **Regiune**: ${region}` : ''}
${!entity_cui && !region ? '- **Nivel**: Național (toate entitățile)' : ''}
- **Domeniu investigat**: ${investigation_focus}
- **Perioadă**: ${yearDisplay}

## Obiective

1. Definește și explică categoria investigată (ce include, de ce este importantă)
2. Defalcare ierarhică completă (de la capitol la subcategorii detaliate)
3. Evoluție temporală (dacă perioada multi-anuală)
4. Comparație relativă (categoria ca % din buget total)
5. Identificare entități cu alocări neobișnuite
6. Recomandări bazate pe findings

---

## Stil de comunicare

- **Investigativ**: Pune întrebări și răspunde sistematic ("De ce?", "Cum?", "Cine?")
- **Detaliat**: Drill-down până la nivel granular - nu te opri la generalități
- **Contextual**: Explică de ce categoria este importantă pentru servicii publice
- **Documentat**: Referențiază legislație și standarde când este relevant

---

## Fluxul de investigație

### Etapa 1: Identificarea Codului Precis

**Acțiune**: Folosește \`discover_filters\` pentru a identifica codul funcțional sau economic exact pentru "${investigation_focus}".

**Query pentru functional**:
\`\`\`json
{
  "category": "functional_classification",
  "query": "${investigation_focus}"
}
\`\`\`

**Query pentru economic**:
\`\`\`json
{
  "category": "economic_classification",
  "query": "${investigation_focus}"
}
\`\`\`

**Output așteptat**: Lista de coduri relevante cu denumiri în română.

**Format răspuns**:
\`\`\`
## Definirea Domeniului Investigat

### Cod Identificat: [Cod] - [Denumire Oficială]

**Categorie**: [Funcțională / Economică]
**Cod complet**: [ex. 65. sau 10.01 sau 70.01.01]

**Ce include această categorie**:

[Explicație detaliată preluată din resursa MCP corespunzătoare: functional_classification_guide sau economic_classification_guide]

**De ce este importantă**:

[Context pentru servicii publice - ex. "Educația (65.) este fundamentală pentru dezvoltarea capitalului uman și reprezintă adesea cea mai mare categorie de cheltuieli pentru administrațiile locale."]

**Cadru legal**:

[Referințe relevante din budget_legislation_index - ex. "Clasificarea este reglementată de Ministerul Finanțelor conform standardului COFOG"]
\`\`\`

---

### Etapa 2: Defalcare Ierarhică (Drill-Down)

**Acțiune**: Folosește \`explore_budget_breakdown\` pentru a vedea structura completă a categoriei.

**Parametri**:
\`\`\`json
{
  "period": {
    "type": "YEAR",
    "selection": { "dates": ["${analysisYears[0]}"] }
  },
  "filter": {
    "accountCategory": "ch",
    ${entity_cui ? `"entityCuis": ["${entity_cui}"],` : ''}
    ${region ? `"countyCodes": ["[cod din discover_filters]"],` : ''}
    "functionalPrefixes": ["[cod din discover_filters]"] // sau economicPrefixes
  },
  "breakdown": "functional" // sau "economic" după caz
}
\`\`\`

**Format răspuns**:
\`\`\`
## Defalcare Ierarhică Completă

### Structura Categoriei "${investigation_focus}"

**Link explorare interactivă**: [dataLink din explore_budget_breakdown]

#### Nivel 1: Capitole (Top Level)

${entity_cui ? '[Pentru entitate specifică]' : '[Agregat pentru toate entitățile în scope]'}

| Capitol | Denumire | Valoare | % din categoria investigată | % din buget total |
|---------|----------|---------|------------------------------|-------------------|
| [ex. 65.10] | Învățământ preșcolar și primar | 15.2M RON | 45% | 12% |
| [ex. 65.20] | Învățământ secundar | 10.8M RON | 32% | 9% |
| [ex. 65.30] | Învățământ profesional | 5.4M RON | 16% | 4% |
| [ex. 65.60] | Servicii auxiliare învățământ | 2.3M RON | 7% | 2% |
| **TOTAL** | **Învățământ (65.)** | **33.7M RON** | **100%** | **27%** |

**Observații**:
- Învățământul primar și preșcolar domină categoria (45%), normal pentru majoritatea entităților locale care au responsabilitate directă pentru ciclul primar.
- Învățământul secundar reprezintă 32% - responsabilitate adesea partajată cu consiliile județene.
- Serviciile auxiliare (transport școlar, cantine, burse) sunt doar 7% - verificați dacă este suficient.

---

#### Nivel 2: Subcategorii Detaliate (pentru fiecare capitol major)

**Exemplu: 65.10 - Învățământ preșcolar și primar**

[Dacă sistemul permite drill-down mai profund, folosește din nou explore_budget_breakdown cu prefix "65.10"]

| Subcategorie | Denumire | Valoare | % din 65.10 |
|--------------|----------|---------|-------------|
| 65.10.01 | Grădinițe | 6.2M RON | 41% |
| 65.10.02 | Învățământ primar | 8.5M RON | 56% |
| 65.10.03 | Servicii administrative învățământ primar | 0.5M RON | 3% |

**Observații**:
- Grădinițele (41%) au alocare semnificativă - verificați capacitatea și gradul de acoperire
- Serviciile administrative sunt minime (3%) - eficiență bună sau subfinanțare?

---

[Repetă pentru alte capitole majore din categorie]
\`\`\`

---

### Etapa 3: Analiza Economică a Categoriei (Pe ce se cheltuie?)

**Acțiune**: Combină analiza funcțională cu cea economică pentru a vedea NATURA cheltuielilor în categoria investigată.

**Tool**: \`explore_budget_breakdown\` cu breakdown="economic" și același filter funcțional.

**Întrebări**:
- Cât % merge pe salarii (10.)?
- Cât % pe bunuri și servicii (20.)?
- Cât % pe investiții (70.)?

**Format răspuns**:
\`\`\`
## Structura Economică - Cum se cheltuie pe "${investigation_focus}"?

| Categorie Economică | Valoare | % din ${investigation_focus} |
|---------------------|---------|-------------------------------|
| **Salarii (10.)** | 22.5M RON | 67% |
| **Bunuri și servicii (20.)** | 8.2M RON | 24% |
| **Investiții (70.)** | 2.8M RON | 8% |
| **Altele** | 0.2M RON | 1% |
| **TOTAL** | 33.7M RON | 100% |

**Interpretare**:

📊 **Dominat de salarii** (67%): Normal pentru domeniul educației, unde personalul (profesori) este resursa principală. Acest procent este în linie cu media națională pentru educație.

📦 **Bunuri și servicii** (24%): Include utilități (încălzit școli), materiale didactice, reparații curente, curățenie. Procent rezonabil.

🏗️ **Investiții** (8%): Relativ modest - indică că majoritatea bugetului merge pe funcționare, nu pe construcții/renovări noi.
- **Risc**: Dacă investițiile sunt constant <10%, infrastructura se degradează în timp.
- **Recomandare**: Creșteți ponderea investițiilor la min. 15% pentru modernizare susținută.

**Comparație cu alte categorii funcționale**:

[Opțional, dacă datele permit]:
- Sănătate (66.): 55% salarii, 30% bunuri, 15% investiții
- Administrație (51.): 70% salarii, 25% bunuri, 5% investiții

**Concluzie**: Educația are structură tipică pentru servicii intensive în personal, dar ar beneficia de mai multe investiții capitale.
\`\`\`

---

### Etapa 4: Evoluție Temporală (dacă multi-anual)

${isMultiYear ? `
**Acțiune**: Folosește \`query_timeseries_data\` pentru a vedea cum a evoluat categoria în perioada ${yearDisplay}.

**Parametri**:
\`\`\`json
{
  "title": "Evoluția ${investigation_focus} - ${yearDisplay}",
  "period": {
    "type": "YEAR",
    "selection": {
      "interval": {
        "start": "${Math.min(...analysisYears)}",
        "end": "${Math.max(...analysisYears)}"
      }
    }
  },
  "series": [
    {
      "label": "${investigation_focus} - Cheltuieli",
      "filter": {
        "accountCategory": "ch",
        ${entity_cui ? `"entityCuis": ["${entity_cui}"],` : ''}
        "functionalPrefixes": ["[cod]"]
      }
    }
  ]
}
\`\`\`

**Format răspuns**:
\`\`\`
## Evoluția în Timp - ${investigation_focus}

**Link grafic interactiv**: [dataLink]

### Tablou Evolutiv

| An | Valoare | YoY | % din buget total | Observații |
|----|---------|-----|-------------------|------------|
| ${Math.min(...analysisYears)} | [val] | - | [%] | Bază de referință |
| ${Math.min(...analysisYears) + 1} | [val] | [+/-]% | [%] | [Notă] |
| ... | ... | ... | ... | ... |
| ${Math.max(...analysisYears)} | [val] | [+/-]% | [%] | [Notă] |

**Creștere cumulativă**: [%] (de la [val] la [val])
**CAGR**: [%] pe an

**Trend identificat**: [Crescător / Descrescător / Stabil / Volatil]

**Schimbări majore**:
1. [Ex. Salt în anul X cu +30% datorat construcției unei școli noi]
2. [Ex. Scădere în anul Y cu -15% datorat închiderii unor unități]

**Interpretare**: [Context și explicații]
\`\`\`
` : `
**Notă**: Analiza este pentru un singur an (${yearDisplay}). Pentru perspective temporale, rulați din nou cu parametrul "years" ca array: [${analysisYears[0] - 2}, ${analysisYears[0] - 1}, ${analysisYears[0]}].
`}

---

### Etapa 5: Comparație Relativă (Categoria ca % din Total)

**Acțiune**: Compară ponderea categoriei investigate în bugetul total, atât pentru entitatea analizată cât și pentru peers/media națională.

${entity_cui ? `
**Pentru entitate specifică**:
- Obține total buget din \`get_entity_snapshot\`
- Calculează: (Valoare categorie / Total cheltuieli) × 100%

**Pentru peers**:
- Folosește \`rank_entities\` cu filter pentru categoria specifică
- Calculează ponderea pentru fiecare peer
- Compară entitatea cu mediana
` : ''}

**Format răspuns**:
\`\`\`
## Importanța Relativă în Buget

### Ponderea "${investigation_focus}" în Bugetul Total

${entity_cui ? `
**Entitatea analizată**:
- ${investigation_focus}: 33.7M RON
- Total cheltuieli: 125M RON
- **Pondere**: 27% din buget

**Mediana peers** (entități similare):
- Pondere medie: 24%
- Interval tipic: 20-30%

**Concluzie**: Entitatea alocă ușor peste mediană pentru ${investigation_focus} (+3pp). Acest lucru poate indica:
- Prioritizare a domeniului (pozitiv dacă rezultatele sunt bune)
- Necesități mai mari decât peers (ex. mai multe școli, populație tânără)
- Ineficiență (dacă rezultatele nu justifică investiția)
` : `
**Agregat ${region || 'național'}**:
- ${investigation_focus}: [Valoare totală]
- Total cheltuieli: [Valoare totală]
- **Pondere medie**: [%]

**Variabilitate între entități**:
- Min: [%] (entitatea [nume])
- Max: [%] (entitatea [nume])
- Mediană: [%]

**Observație**: Ponderea variază semnificativ între entități (de la [min] la [max]), indicând diferențe în priorități locale sau nevoi specifice.
`}
\`\`\`

---

### Etapa 6: Identificare Entități cu Alocări Neobișnuite

**Acțiune**: Folosește \`rank_entities\` pentru a identifica outliers la categoria investigată.

**Parametri**:
\`\`\`json
{
  "period": {
    "type": "YEAR",
    "selection": { "dates": ["${analysisYears[0]}"] }
  },
  "filter": {
    "accountCategory": "ch",
    "functionalPrefixes": ["[cod]"], // sau economicPrefixes
    "normalization": "per_capita"
  },
  "sort": {
    "by": "per_capita_amount",
    "order": "DESC"
  },
  "limit": 100
}
\`\`\`

**Analiză statistică**: Calculează mediană, media, deviație standard, identifică outliers (>2σ).

**Format răspuns**:
\`\`\`
## Entități cu Alocări Atipice

### Distribuție Cheltuieli per Capita - "${investigation_focus}"

**Statistici**:
- Mediană: 450 RON/capita
- Media: 480 RON/capita
- Deviație standard: 120 RON/capita
- Prag outlier superior: >720 RON/capita (Media + 2σ)
- Prag outlier inferior: <240 RON/capita (Media - 2σ)

---

### Outliers Superiori (Alocări Foarte Mari)

#### 1. [Nume Entitate] ([Tip], [Județ])

**CUI**: [cui]
**Alocare per capita**: 950 RON/capita (+111% față de mediană)
**Total**: 19M RON
**Link**: [short link din get_entity_snapshot]

**Investigare**:
[Folosește get_entity_snapshot și analyze_entity_budget pentru a vedea de ce]

**Explicații identificate**:
1. **Proiect major**: Construcție liceu nou (12M RON) în ${analysisYears[0]} - investiție excepțională
2. **Statut special**: Reședință de județ, are și școli pentru zonele rurale limitrofe
3. **Fonduri UE**: Accesat POCU pentru modernizare infrastructură educațională

**Este justificat?**: Da - investiția creează infrastructură pe termen lung.

---

#### 2. [Altă entitate outlier superior]

[Continuă analiza]

---

### Outliers Inferiori (Alocări Foarte Mici)

#### 1. [Nume Entitate] ([Tip], [Județ])

**CUI**: [cui]
**Alocare per capita**: 180 RON/capita (-60% față de mediană)
**Total**: 1.8M RON
**Link**: [short link]

**Investigare**:

**Explicații identificate**:
1. **Populație vârstnică**: Comună cu puțini copii → mai puține nevoi educaționale
2. **Școli închise/comasate**: Copiii merg la școli din comunele învecinate
3. **Subfinanțare**: Venituri insuficiente pentru menținerea standardelor

**Este o problemă?**: Posibil - verificați:
- Starea infrastructurii (școlile sunt în bună stare?)
- Accesul copiilor la educație (distanțe mari, transport?)
- Calitatea educației (rezultate la examene, profesori calificați?)

**Recomandare**: Dacă subfinanțarea afectează calitatea, necesită intervenție (transfer suplimentar, parteneriat intercomunal).

---

[Continuă pentru alte outliers]
\`\`\`

---

### Etapa 7: Pattern-uri și Corelații

**Acțiune**: Caută pattern-uri între outliers și alte caracteristici.

**Întrebări de investigat**:
1. **Geografic**: Sunt outliers concentrați într-o regiune?
2. **Economic**: Corelează cu venitul mediu, șomajul?
3. **Demografic**: Corelează cu vârsta medie, populația?
4. **Politic**: Diferențe între entități guvernate de partide diferite?

**Format răspuns**:
\`\`\`
## Pattern-uri Identificate

### 1. Clustering Geografic

**Observație**: Entitățile din regiunea [Regiune] alocă în medie +25% mai mult pentru ${investigation_focus} față de media națională.

**Posibile explicații**:
- [Ex. Regiunea are fonduri de dezvoltare dedicate educației]
- [Ex. Populație mai tânără → mai mulți copii → nevoi mai mari]
- [Ex. Tradiție locală de prioritizare a educației]

---

### 2. Corelație cu Venitul Mediu

**Observație**: Entitățile cu venituri per capita >1,500 RON alocă cu 40% mai mult pentru ${investigation_focus} decât cele cu venituri <800 RON/capita.

**Interpretare**: Entitățile mai bogate își permit investiții mai mari. Risc de inegalitate teritorială - copiii din zone sărace au acces la educație mai puțin finanțată.

**Recomandare politică**: Sistemul de transferuri ar trebui să compenseze aceste disparități (prin cote majorate pentru entități sărace).

---

### 3. [Alte pattern-uri]

[Adaugă alte observații]
\`\`\`

---

### Etapa 8: Recomandări Bazate pe Investigație

**Format răspuns**:
\`\`\`
## Recomandări și Concluzii

### Pentru Entitatea Analizată ${entity_cui ? `(CUI ${entity_cui})` : ''}

${entity_cui ? `
#### Recomandări Specifice

1. **[Exemplu: Creștere investiții în ${investigation_focus}]** (prioritate: înaltă)
   - **Context**: Investițiile actuale (8%) sunt sub nivelul necesar pentru modernizare
   - **Acțiune**: Creșteți alocarea pentru investiții la min. 15% din categoria ${investigation_focus}
   - **Surse de finanțare**: Căutați fonduri PNRR, POCU, sau împrumuturi BEI pentru educație
   - **Impact așteptat**: Îmbunătățirea infrastructurii → calitate educațională mai bună

2. **[Altă recomandare specifică]**
   [Detalii]
` : ''}

---

### Pentru Autoritățile Centrale/Regionale

1. **Reducerea disparităților teritoriale** (prioritate: înaltă)
   - **Observație**: Diferență de 5× între entități bogate și sărace la alocarea per capita pentru ${investigation_focus}
   - **Acțiune**: Revizuiți formula de transfer pentru a asigura standard minim pe toate entitățile
   - **Exemplu**: Garantați minimum 300 RON/capita pentru ${investigation_focus} pentru toate entitățile

2. **Promovarea best practices**
   - **Observație**: Unele entități obțin rezultate excelente cu alocări moderate (eficiență)
   - **Acțiune**: Documentați și distribuiți metodele acestor entități (ghiduri, training, conferințe)

3. **Monitorizare continuă**
   - **Acțiune**: Actualizați această analiză anual pentru a urmări evoluția și impactul politicilor

---

### Întrebări Rămase pentru Investigații Ulterioare

1. **Calitatea vs. Cantitatea**: Cum corelează alocarea bugetară cu rezultatele (ex. rate promovabilitate, satisfacție cetățeni)?
2. **Eficiența**: Care entități obțin cele mai bune rezultate cu resursele cele mai mici?
3. **Sustenabilitate**: Sunt investițiile actuale finanțate sustenabil (venituri proprii) sau din datorii/fonduri temporare?

---

### Surse și Metodologie

**Date utilizate**:
- Platforma Transparenta.eu - execuție bugetară ${yearDisplay}
- Ministerul Finanțelor - clasificări bugetare

**Metodologie**:
- Analiză descriptivă (distribuție, mediană, medie)
- Analiză comparativă (peers, timp)
- Identificare outliers (±2σ)

**Limitări**:
- Analiza se bazează pe date bugetare (input), nu pe rezultate (output/outcomes)
- Pattern-urile identificate sunt corelații, nu neapărat cauzalitate
- Contextele locale specifice pot justifica aparente anomalii

---

### Link-uri Partajabile

**Explorare ierarhică**: [dataLink din explore_budget_breakdown]
${isMultiYear ? '**Evoluție temporală**: [dataLink din query_timeseries_data]' : ''}
**Ranking entități**: [dataLink din rank_entities]
${entity_cui ? `**Profil entitate**: [link din get_entity_snapshot]` : ''}

**Top outliers investigați**:
1. [Entitate 1]: [link]
2. [Entitate 2]: [link]
3. [Entitate 3]: [link]

---

**Investigație finalizată**: [Data curentă]
**Domeniu**: ${investigation_focus}
**Scope**: ${scope}
**Perioadă**: ${yearDisplay}
\`\`\`

---

## Note Finale pentru AI

1. **Profunzime**: Această analiză trebuie să fie cea mai detaliată - drill-down până la nivelul maxim disponibil
2. **Context legislativ**: Referențiază resursele MCP (functional/economic guides, legislation) pentru context
3. **Explicații**: Nu doar constată, ci explică DE CE categoria este importantă și ce înseamnă cifrele
4. **Outliers**: Investigare individuală pentru top 3-5 outliers cu analiza cauzelor
5. **Acționabil**: Recomandări concrete și implementabile bazate pe findings
6. **Link-uri**: Include toate link-urile pentru verificare și explorare ulterioară

---

**Începe investigația acum pentru domeniul "${investigation_focus}", ${scope}, ${yearDisplay}.**
`;
}
