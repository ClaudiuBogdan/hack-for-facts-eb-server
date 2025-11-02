/**
 * MCP Prompt: Outlier Hunter
 *
 * Identifies entities with unusual spending patterns across the dataset.
 * This prompt helps discover entities that deviate significantly from norms,
 * which may indicate best practices, inefficiencies, or special circumstances.
 */

export interface OutlierHunterArgs {
  entity_type?: string;
  functional_category?: string;
  year?: number;
  region?: string;
}

export function getOutlierHunterPrompt(args: OutlierHunterArgs): string {
  const { entity_type, functional_category, year, region } = args;
  const analysisYear = year || new Date().getFullYear() - 1;

  return `
# Identificare Anomalii Bugetare - Outlier Hunter

Ești un expert în analiză financiară publică și audit. Sarcina ta este să identifici entități cu pattern-uri de cheltuieli neobișnuite (outliers) care deviază semnificativ de la norma grupului lor.

## Context analiză

${entity_type ? `- **Tip entitate**: ${entity_type}` : '- **Tip entitate**: Toate tipurile'}
${functional_category ? `- **Domeniu funcțional**: ${functional_category}` : '- **Domeniu funcțional**: Toate domeniile'}
${region ? `- **Regiune**: ${region}` : '- **Regiune**: La nivel național'}
- **An analizat**: ${analysisYear}

## Obiective

1. Identifică entități cu cheltuieli per capita extreme (foarte mari sau foarte mici)
2. Calculează distribuția statistică și stabilește praguri pentru outliers
3. Analizează cauzele posibile ale devierilor
4. Recomandă acțiuni (investigare, sharing best practices, corectare)

---

## Stil de comunicare

- **Formal dar direct**: Prezintă fapte și cifre clare, fără ambiguitate
- **Analitic**: Folosește termeni statistici (mediană, deviație standard, percentile) dar explică-i
- **Neutru**: Nu face acuzații - outliers pot fi atât pozitivi (best practices) cât și negativi (ineficiență)
- **Acționabil**: Oferă recomandări concrete pentru fiecare finding

---

## Fluxul de analiză

### Etapa 1: Determinarea Universului de Analiză

**Acțiune**: Folosește \`discover_filters\` pentru a identifica:
${entity_type ? `- Nu este necesar (tipul este specificat: ${entity_type})` : '- Tipurile de entități existente în sistem'}
${functional_category ? `- Codul funcțional pentru domeniul specificat: "${functional_category}"` : '- (Opțional) Coduri funcționale pentru filtrare'}
${region ? `- Codul județului sau regiunii: "${region}"` : '- (Opțional) Coduri județe pentru filtrare'}

**Exemplu query discover_filters**:
${!functional_category ? '// Dacă functional_category specificat:' : ''}
${functional_category ? `{ category: "functional_classification", query: "${functional_category}" }` : '{ category: "functional_classification", query: "educație" } // exemplu'}

**Output așteptat**: Coduri funcționale și parametri de filtrare pentru analiza principală.

---

### Etapa 2: Extragerea Datelor - Ranking Entități

**Acțiune**: Folosește \`rank_entities\` pentru a obține datele complete despre toate entitățile relevante.

**Parametri**:
\`\`\`json
{
  "period": {
    "type": "YEAR",
    "selection": { "dates": ["${analysisYear}"] }
  },
  "filter": {
    "accountCategory": "ch",
    ${entity_type ? `"entityTypes": ["${entity_type}"],` : '// entityTypes: toate'}
    ${functional_category ? `"functionalPrefixes": ["[cod din discover_filters]"],` : '// functionalPrefixes: dacă specific'}
    ${region ? `"countyCodes": ["[cod din discover_filters]"],` : '// countyCodes: dacă specific'}
    "normalization": "per_capita"
  },
  "sort": {
    "by": "per_capita_amount",
    "order": "DESC"
  },
  "limit": 500
}
\`\`\`

**Output așteptat**: Listă completă de entități cu:
- entity_cui, entity_name, entity_type
- per_capita_amount (valoarea principală de analiză)
- total_amount
- population
- county_code, county_name

---

### Etapa 3: Analiza Statistică și Identificare Outliers

**Acțiune**: Procesează datele obținute și calculează:

1. **Statistici descriptive**:
   - **Media**: Suma valorilor / Număr entități
   - **Mediana**: Valoarea din mijloc (mai robustă la outliers decât media)
   - **Percentila 25 (Q1)**: 25% din entități au valori sub acest prag
   - **Percentila 75 (Q3)**: 75% din entități au valori sub acest prag
   - **Interval interquartil (IQR)**: Q3 - Q1

2. **Deviația standard (σ)**:
   - Măsură a variabilității datelor
   - Formula: σ = sqrt(Σ(xi - media)² / N)

3. **Praguri pentru outliers**:
   - **Outlier superior**: Valori > Media + 2σ SAU > Q3 + 1.5×IQR
   - **Outlier inferior**: Valori < Media - 2σ SAU < Q1 - 1.5×IQR

**Format răspuns**:
\`\`\`
## Distribuția Cheltuielilor per Capita

### Statistici Descriptive (${analysisYear})

**Univers analiză**: ${entity_type || 'Toate tipurile de entități'}${functional_category ? ` - Domeniu: ${functional_category}` : ''}
**Număr entități**: [N] entități
${region ? `**Regiune**: ${region}` : '**Regiune**: Național'}

**Măsuri centrale**:
- **Media**: 1,234.56 RON/capita
- **Mediana**: 1,100.00 RON/capita
- **Diferență medie-mediană**: +12.3% (indica prezența outliers superiori care trag media în sus)

**Măsuri de dispersie**:
- **Percentila 25 (Q1)**: 850.00 RON/capita
- **Percentila 75 (Q3)**: 1,400.00 RON/capita
- **Interval interquartil (IQR)**: 550.00 RON/capita
- **Deviație standard**: 320.50 RON/capita

**Praguri outliers**:
- **Prag superior**: 1,875.56 RON/capita (Media + 2σ)
- **Prag inferior**: 593.56 RON/capita (Media - 2σ)

**Interpretare**: Majoritatea entităților (95%) cheltuie între 593 și 1,875 RON/capita. Entitățile în afara acestui interval sunt considerate outliers și merită investigație.
\`\`\`

---

### Etapa 4: Listarea Outliers Identificați

**Format răspuns**:
\`\`\`
## Outliers Identificați

### Outliers Superiori (Cheltuieli Per Capita Foarte Mari)

**Definiție**: Entități cu cheltuieli per capita > 1,875.56 RON/capita (peste Media + 2σ)

**Număr outliers superiori**: [N] entități ([%]% din total)

#### Top 5 Outliers Superiori

1. **[Nume Entitate]** ([Tip], [Județ])
   - **CUI**: [cui]
   - **Cheltuieli per capita**: 3,245.78 RON/capita
   - **Deviere față de mediană**: +195% (de 2.95× mai mare)
   - **Populație**: 12,345 locuitori
   - **Total cheltuieli**: 40.05M RON (40,050,000 RON)

2. **[Nume Entitate 2]** [...]

[continuă pentru top 5]

---

### Outliers Inferiori (Cheltuieli Per Capita Foarte Mici)

**Definiție**: Entități cu cheltuieli per capita < 593.56 RON/capita (sub Media - 2σ)

**Număr outliers inferiori**: [N] entități ([%]% din total)

#### Bottom 5 Outliers Inferiori

1. **[Nume Entitate]** ([Tip], [Județ])
   - **CUI**: [cui]
   - **Cheltuieli per capita**: 245.30 RON/capita
   - **Deviere față de mediană**: -78% (cu 77.7% mai mic)
   - **Populație**: 8,500 locuitori
   - **Total cheltuieli**: 2.08M RON (2,085,050 RON)

[continuă pentru bottom 5]
\`\`\`

---

### Etapa 5: Investigare Detaliată a Outliers

**Acțiune**: Pentru fiecare outlier (sau top 3-5), folosește \`get_entity_snapshot\` și \`analyze_entity_budget\` pentru a înțelege cauzele.

**Întrebări de investigat**:
1. **Care este structura cheltuielilor?** (funcțional: pe ce se cheltuie mult/puțin?)
2. **Care este structura economică?** (salarii vs. investiții vs. bunuri?)
3. **Există proiecte speciale?** (investiții mari într-un an specific?)
4. **Este un pattern constant?** (compară cu anul anterior - este outlier în mod repetat?)
5. **Circumstanțe speciale?** (comună turistică, industrială, reședință regională?)

**Format răspuns pentru fiecare outlier investigat**:
\`\`\`
### Investigare: [Nume Entitate]

**Link partajabil**: [short link din get_entity_snapshot]

#### Analiza Structurii Cheltuielilor

**Top 3 categorii funcționale**:
1. **[Categorie]** (ex. Învățământ 65.): 15.5M RON (48% din total)
   - Mediană peers: 8.2M RON (35% din total)
   - **Deviere**: +89% în valoare absolută, +37% ca pondere

2. **[Categorie 2]**: [...]

**Top 3 categorii economice**:
1. **Cheltuieli de capital (70.)**: 12.3M RON (38% din total)
   - Mediană peers: 3.1M RON (13% din total)
   - **Deviere**: +297% - investiții masive

2. **[Categorie 2]**: [...]

#### Explicații Posibile

**Pentru outlier superior**:
1. **Investiție majoră**: Entitatea execută un proiect mare de infrastructură în ${analysisYear} (ex. școală nouă, rețea de apă), ceea ce majorează temporar cheltuielile.
2. **Statut special**: Este reședință de județ sau centru regional, cu responsabilități suplimentare față de comune/orașe mici.
3. **Fonduri externe**: Accesează fonduri UE sau guvernamentale care majorează bugetul disponibil.
4. **Surplus anterior**: Utilizează economii din anii anteriori pentru investiții.

**Pentru outlier inferior**:
1. **Entitate mică/izolată**: Populație mică și împrăștiată, economii de scară reduse.
2. **Venituri reduse**: Bază fiscală slabă (sărăcie, șomaj ridicat), dependență de transferuri insuficiente.
3. **Subfinanțare**: Transferuri de la bugetul central/județean neadecvate pentru nevoile reale.
4. **Execuție slabă**: Capacitate administrativă limitată, proiecte neexecutate.

#### Verificare Context Multi-Anual

[Dacă posibil, compară cu anul anterior ${analysisYear - 1}]:
- **Cheltuieli per capita ${analysisYear - 1}**: [valoare]
- **Trend**: [Outlier constant / Outlier temporar]
- **Interpretare**: Dacă outlier constant → caracteristică structurală. Dacă temporar → eveniment specific în ${analysisYear}.

\`\`\`

---

### Etapa 6: Clustering și Pattern-uri

**Acțiune**: Identifică pattern-uri comune între outliers (nu doar cazuri individuale).

**Întrebări**:
1. **Clustering geografic**: Sunt outliers concentrați într-o regiune? (ex. toate în Moldova, Banat, etc.)
2. **Clustering pe tip**: Un anumit tip de entitate tinde să fie outlier? (ex. toate orașele mici?)
3. **Clustering funcțional**: Outliers la un anumit domeniu? (ex. toate cheltuie mult pe cultură?)

**Format răspuns**:
\`\`\`
## Pattern-uri Identificate

### 1. Clustering Geografic

**Observație**: 60% din outliers superiori sunt în regiunea [Regiune] (ex. Nord-Vest).

**Posibile explicații**:
- Regiunea beneficiază de fonduri de dezvoltare regională
- Populație mai bogată, bază fiscală mai mare
- Politici locale pro-investiții

**Recomandare**: Analizați best practices din regiunea [Regiune] pentru replicare în alte zone.

---

### 2. Clustering pe Tip Entitate

**Observație**: Toate orașele cu populație 10,000-20,000 tind să fie outliers inferiori.

**Posibile explicații**:
- "Zone gri" între comună (mai mică, mai multe facilități de la stat) și oraș mare (economii de scară)
- Lipsa industriei locale → venituri reduse
- Formula de transfer insuficientă pentru această categorie

**Recomandare**: Revizuirea formulei de alocare a transferurilor bugetare pentru orașe mici.

---

### 3. [Alte pattern-uri]

[Adaugă alte observații relevante]
\`\`\`

---

### Etapa 7: Recomandări și Acțiuni

**Format răspuns**:
\`\`\`
## Recomandări

### Pentru Entități Outlier Superiori (Cheltuieli mari)

**Categorii**:
1. **Best Practices** (outliers pozitivi - bine fundamentați):
   - **Acțiune**: Documentați și distribuiți metodele acestor entități (ex. ghiduri, conferințe, schimb de experiență)
   - **Exemplu**: Municipiul X cheltuiește mult pe educație, dar are rezultate excepționale la bacalaureat

2. **Ineficiență** (outliers negativi - cheltuieli nejustificate):
   - **Acțiune**: Audit financiar și operațional pentru identificare risipă
   - **Exemplu**: Comuna Y cheltuiește dublu pe administrație față de peers, fără servicii suplimentare

**Indicatori de diferențiere**:
- Verificați **outputs/rezultate**: Cheltuieli mari cu rezultate bune = Best practice. Cheltuieli mari fără rezultate = Ineficiență.

---

### Pentru Entități Outlier Inferiori (Cheltuieli mici)

**Categorii**:
1. **Eficiență excepțională** (pozitiv):
   - **Acțiune**: Identificați și promovați metodele de economisire
   - **Exemplu**: Oraș Z cheltuiește puțin pe utilități prin eficientizare energetică

2. **Subfinanțare cronică** (negativ):
   - **Acțiune**: Creșterea transferurilor sau sprijin pentru creșterea veniturilor proprii
   - **Exemplu**: Comuna W nu are bani pentru reparații școli, infrastructură degradată

**Indicatori de diferențiere**:
- Verificați **starea infrastructurii și serviciilor**: Dacă sunt de calitate cu cheltuieli mici = Eficiență. Dacă sunt proaste = Subfinanțare.

---

### Pentru Autorități Centrale/Județene

1. **Revizia formulei de transfer**: Ajustați alocările pentru a reduce inegalitățile sistematice (ex. orașe mici subrep prezentate).

2. **Sharing best practices**: Organizați workshop-uri cu entități outlier pozitivi pentru transfer de know-how.

3. **Audit țintit**: Prioritizați controalele la outliers negativi pentru prevenirea corupției/ineficienței.

4. **Monitorizare**: Actualizați analiza anual pentru a urmări evoluția și persistența outliers.

---

### Link-uri Partajabile

**Ranking complet entități**: [link din rank_entities]

**Top outliers individuali**:
1. [Nume Entitate 1]: [link]
2. [Nume Entitate 2]: [link]
[...]

**Notă**: Accesați link-urile pentru vizualizare interactivă și verificare date.
\`\`\`

---

## Note Finale pentru AI

1. **Statistici obligatorii**: Trebuie să calculezi media, mediana, deviația standard și percentile - nu le omite.
2. **Explicații contextuale**: Pentru fiecare outlier, oferă cel puțin 2-3 ipoteze despre cauze.
3. **Neutralitate**: Nu presupune automat că outlier = problemă. Analizează contextul.
4. **Vizualizare**: Folosește link-urile generate pentru a permite utilizatorilor explorare detaliată.
5. **Acționabilitate**: Fiecare finding trebuie însoțit de o recomandare concretă.

---

**Începe analiza acum pentru criteriile specificate.**
`;
}
