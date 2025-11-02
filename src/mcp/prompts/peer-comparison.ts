/**
 * MCP Prompt: Peer Comparison
 *
 * Benchmarks a single entity against similar peers to understand relative
 * performance, identify best practices, and highlight areas for improvement.
 */

export interface PeerComparisonArgs {
  entity_cui: string;
  comparison_dimension?: 'per_capita' | 'total' | 'by_category';
  year?: number;
}

export function getPeerComparisonPrompt(args: PeerComparisonArgs): string {
  const { entity_cui, comparison_dimension = 'per_capita', year } = args;
  const analysisYear = year || new Date().getFullYear() - 1;

  return `
# Analiză Comparativă - Benchmarking față de Entități Similare

Ești un expert în benchmarking financiar public. Sarcina ta este să compari entitatea **CUI ${entity_cui}** cu entități similare (peers) pentru anul **${analysisYear}**, identificând puncte forte, puncte slabe și oportunități de îmbunătățire.

## Dimensiune de comparație

**Mod selectat**: ${comparison_dimension}
${comparison_dimension === 'per_capita' ? '- Comparații ajustate la populație (echitabil pentru entități de dimensiuni diferite)' : ''}
${comparison_dimension === 'total' ? '- Comparații în valori absolute (pentru entități de dimensiune similară)' : ''}
${comparison_dimension === 'by_category' ? '- Comparații detaliate pe categorii funcționale și economice' : ''}

## Obiective

1. Identifică grupul de entități comparabile (peers)
2. Calculează poziția entității în clasament (percentile)
3. Identifică categoriile unde entitatea este outlier (pozitiv sau negativ)
4. Extrage best practices de la top performers
5. Recomandă acțiuni concrete de îmbunătățire

---

## Stil de comunicare

- **Comparativ**: Folosește constant referințe la peers ("față de medie", "peste mediană", "în top 25%")
- **Cantitativ**: Prezintă diferențe precise în % și valori absolute
- **Echilibrat**: Evidențiază atât puncte forte cât și puncte slabe
- **Orientat spre acțiune**: Pentru fiecare finding, sugerează ce poate face entitatea

---

## Fluxul de analiză

### Etapa 1: Profil Entitate Analizată

**Acțiune**: Folosește \`get_entity_snapshot\` pentru a obține informațiile de bază.

**Format răspuns**:
\`\`\`
## Entitatea Analizată

**Nume**: [Nume complet în română]
**CUI**: ${entity_cui}
**Tip**: [ex. Oraș]
**Județ**: [ex. Cluj]
**Populație**: [ex. 25,340] locuitori
**An analizat**: ${analysisYear}

**Indicatori financiari**:
- **Venituri totale**: [Compact] ([Full])
- **Cheltuieli totale**: [Compact] ([Full])
- **Venituri per capita**: [valoare] RON/capita
- **Cheltuieli per capita**: [valoare] RON/capita

**Link profil complet**: [short link din get_entity_snapshot]
\`\`\`

---

### Etapa 2: Definirea Grupului de Peers

**Acțiune**: Determină criteriile pentru entități comparabile și folosește \`rank_entities\` pentru a extrage lista.

**Criterii de similaritate**:
1. **Tip entitate**: Același tip (Municipiu, Oraș, Comună, Județ, etc.)
2. **Dimensiune**: Populație în interval ±30% (ex. dacă entitatea are 25,000 locuitori → peers între 17,500-32,500)
3. **Regiune**: (Opțional) Aceeași zonă geografică pentru contexte economice similare
4. **Tip economic**: (Opțional) Urban vs. rural, industrial vs. agricol

**Parametri rank_entities**:
\`\`\`json
{
  "period": {
    "type": "YEAR",
    "selection": { "dates": ["${analysisYear}"] }
  },
  "filter": {
    "accountCategory": "ch",
    // Adaugă filtre pentru tip, regiune după identificare
    "normalization": "${comparison_dimension === 'per_capita' ? 'per_capita' : 'total'}"
  },
  "sort": {
    "by": "${comparison_dimension === 'per_capita' ? 'per_capita_amount' : 'amount'}",
    "order": "DESC"
  },
  "limit": 100
}
\`\`\`

**Format răspuns**:
\`\`\`
## Grupul de Peers

**Criterii de selecție**:
- Tip: [ex. Orașe]
- Populație: [17,500 - 32,500] locuitori (±30% față de entitatea analizată)
- Regiune: [ex. Transilvania sau Național]

**Număr peers identificați**: [ex. 23] entități

**Lista peers** (top 10 pentru referință):
1. [Nume Oraș], [Județ], [populație] loc., [cheltuieli per capita]
2. [...]

**Link ranking complet**: [dataLink din rank_entities]
\`\`\`

---

### Etapa 3: Calcul Statistici și Poziționare

**Acțiune**: Pe baza datelor din \`rank_entities\`, calculează:

1. **Statistici descriptive**:
   - Mediană cheltuieli per capita
   - Media cheltuieli per capita
   - Percentila 25 (Q1)
   - Percentila 75 (Q3)
   - Min și Max

2. **Poziția entității**:
   - Rangul în clasament (ex. locul 12 din 23)
   - Percentila (ex. 50% - mediană)
   - Diferența față de mediană (ex. +15% sau -10%)

**Format răspuns**:
\`\`\`
## Poziționare în Clasament

### Cheltuieli Per Capita - Distribuție

**Statistici grup peers**:
- **Mediană**: 1,100 RON/capita
- **Media**: 1,150 RON/capita (diferența medie-mediană sugerează outliers superiori)
- **Percentila 25 (Q1)**: 950 RON/capita
- **Percentila 75 (Q3)**: 1,300 RON/capita
- **Interval**: 750 - 1,850 RON/capita

**Entitatea analizată**:
- **Cheltuieli per capita**: 1,250 RON/capita
- **Rang**: Locul 8 din 23 (top 35%)
- **Percentila**: 65% (peste mediană, în treimea superioară)
- **Diferență față de mediană**: +13.6% (+150 RON/capita)

**Interpretare**: Entitatea cheltuiește peste mediană, dar nu este un outlier. Nivelul de cheltuieli este în limita superioară a intervalului normal și corespunde unei entități cu servicii publice bine dezvoltate sau investiții semnificative.

**Clasificare**:
- ✅ Top 25% (percentila >75%) → "High spender" - verifică dacă corespund servicii de calitate
- ✅ Normal (percentila 25-75%) → **AICI** - În intervalul tipic
- ⚠️ Bottom 25% (percentila <25%) → "Low spender" - verifică dacă serviciile sunt adecvate
\`\`\`

---

### Etapa 4: Comparație Categorială Detaliată

**Acțiune**: Compară entitatea cu peers pe categorii funcționale și economice.

**Tool**: Combină:
- \`analyze_entity_budget\` (breakdown_by="overview") pentru entitatea analizată
- \`rank_entities\` cu filtre funcționale specifice pentru a obține media peers

**Categorii de analizat**:
1. **Funcționale**: Educație (65.), Sănătate (66.), Servicii publice (54.), Administrație (51.), Cultură (67.)
2. **Economice**: Salarii (10.), Bunuri și servicii (20.), Investiții (70.)

**Format răspuns**:
\`\`\`
## Comparație Categorială

### Alocare Funcțională - Entitate vs. Mediană Peers

| Categorie | Entitate | Mediană Peers | Diferență | Interpretare |
|-----------|----------|---------------|-----------|--------------|
| **Educație (65.)** | 480 RON/cap (38%) | 350 RON/cap (32%) | **+37%** ⬆️ | **Punct forte**: Investiție mare în educație, peste medie |
| **Servicii publice (54.)** | 275 RON/cap (22%) | 280 RON/cap (25%) | -2% ➡️ | Similar cu peers |
| **Administrație (51.)** | 180 RON/cap (14%) | 220 RON/cap (20%) | **-18%** ⬇️ | **Eficiență**: Cheltuieli administrative controlate |
| **Sănătate (66.)** | 125 RON/cap (10%) | 110 RON/cap (10%) | +14% ⬆️ | Ușor peste medie |
| **Cultură (67.)** | 100 RON/cap (8%) | 90 RON/cap (8%) | +11% ⬆️ | Similar |
| **Asistență socială (68.)** | 90 RON/cap (7%) | 50 RON/cap (5%) | **+80%** ⬆️ | **Atenție mare persoanelor vulnerabile** |

**Categorii cu devieri semnificative (±30%)**:

#### 1. Educație (65.) - Deviere +37%

**Analiză detaliată**:
[Folosește analyze_entity_budget cu breakdown_by="functional", functionalCode="65"]

**Subcategorii**:
- Învățământ primar (65.10): [valoare] - [comparație cu peers]
- Învățământ secundar (65.20): [valoare] - [comparație]
- Transport școlar (65.60): [valoare] - [comparație]

**Posibile explicații**:
1. **Număr mare de școli**: Entitatea are mai multe școli per capita decât peers → costuri mai mari
2. **Investiții recente**: Construcții/renovări școli în ${analysisYear}
3. **Salarii suplimentare**: Plătește sporuri sau beneficii peste minimum legal
4. **Transport școlar extins**: Zonă dispersată, necesită transport

**Best practice**: Dacă rezultatele la educație (ex. rate promovabilitate, teste naționale) sunt superioare, aceasta este o investiție pozitivă. Dacă rezultatele sunt similare cu peers care cheltuie mai puțin, există oportunități de eficientizare.

**Recomandare pentru peers**: Entitățile cu cheltuieli mai mici pe educație pot învăța de la această entitate cum să prioritizeze și să finanțeze adecvat educația.

---

#### 2. Administrație (51.) - Deviere -18%

**Analiză**:
Entitatea cheltuiește cu 18% mai puțin pe administrație decât mediană peers. Aceasta poate fi:

**Pozitiv** (Eficiență):
- Digitalizare servicii → mai puțini angajați necesari
- Structură organizațională optimizată
- Salarii competitive dar nu excesive
- Externalizare servicii non-core (ex. contabilitate, IT)

**Negativ** (Subfinanțare):
- Personal insuficient → servicii publice lente
- Salarii mici → personal necalificat sau fluctuație mare
- Birou subdimensionat pentru nevoile entității

**Verificare**: Analizează indicatori de performanță:
- Timpul mediu de răspuns la solicitări cetățeni
- Gradul de satisfacție al cetățenilor (sondaje)
- Rata de fluctuație a personalului

**Concluzie**: Dacă serviciile publice funcționează bine, aceasta este o **best practice** de eficiență administrativă. Dacă există probleme de răspuns sau calitate, este necesară re-evaluare.

---

#### 3. Asistență socială (68.) - Deviere +80%

**Analiză**:
Entitatea cheltuiește aproape dublu față de peers pe asistență socială.

**Posibile cauze**:
1. **Populație vulnerabilă mai mare**: Șomaj ridicat, vârstnici, persoane cu dizabilități
2. **Programe locale extinse**: Ajutoare suplimentare față de minimul legal
3. **Centre de zi**: Investiții în infrastructură socială (cămine vârstnici, centre copii)

**Evaluare**:
- **Pozitiv**: Dacă reflectă o nevoie reală și programele sunt eficiente
- **Atenție**: Dacă cheltuielile cresc rapid, verificați sustenabilitatea și eficiența programelor

**Best practice**: Dacă entitatea are programe sociale inovative cu rezultate bune, acestea pot fi replicate de peers.

---

[Continuă pentru alte categorii cu devieri >30%]
\`\`\`

---

### Etapa 5: Comparație Structură Economică

**Format răspuns**:
\`\`\`
## Structura Economică - Entitate vs. Peers

| Categorie Economică | Entitate | Mediană Peers | Diferență |
|---------------------|----------|---------------|-----------|
| **Salarii (10.)** | 560 RON/cap (45%) | 550 RON/cap (50%) | +2% ⬆️ / -5pp |
| **Bunuri și servicii (20.)** | 380 RON/cap (30%) | 330 RON/cap (30%) | +15% ⬆️ / +0pp |
| **Investiții (70.)** | 290 RON/cap (23%) | 165 RON/cap (15%) | **+76%** ⬆️ / +8pp |
| **Alte cheltuieli** | 20 RON/cap (2%) | 55 RON/cap (5%) | -64% ⬇️ / -3pp |

**Notă**: Prima cifră = diferență în valoare absolută, a doua = diferență în ponderea din buget (puncte procentuale)

**Observații**:

1. **Investiții masive**: Entitatea alocă 76% mai mult per capita pentru investiții decât peers. Pondere 23% vs. 15% mediană.
   - **Interpretare pozitivă**: Strategie de dezvoltare agresivă, modernizare infrastructură
   - **Atenție**: Verifică sursa finanțării (împrumuturi? fonduri UE?) și sustenabilitatea

2. **Salarii - ponderea mai mică**: Deși în valoare absolută sunt similare (+2%), ca pondere din buget sunt mai mici (45% vs. 50%).
   - **Interpretare**: Bugetul este diversificat, nu "înghițit" de salarii
   - **Beneficiu**: Mai mult spațiu pentru investiții și servicii

3. **Alte cheltuieli reduse**: Categoria "Alte cheltuieli" (transferuri, dobânzi, etc.) este cu 64% mai mică.
   - **Posibil**: Datorie publică mai mică → mai puține dobânzi de plătit
   - **Verificare**: Compară datoria publică cu peers
\`\`\`

---

### Etapa 6: Identificarea Top Performers (Best Practices)

**Acțiune**: Din lista de peers, identifică top 3-5 entități cu performanță superioară și analizează ce fac diferit.

**Criterii pentru top performers**:
- Cheltuieli per capita moderate (nu extreme)
- Investiții ridicate ca pondere (>20%)
- Eficiență administrativă (administrație <20% din buget)
- (Dacă posibil) Indicatori de calitate buni (gradul de satisfacție, infrastructură)

**Format răspuns**:
\`\`\`
## Top Performers - Best Practices

### Top 3 Entități Exemplare

#### 1. [Nume Oraș A] (Rang 3 / 23)

**CUI**: [cui]
**Cheltuieli per capita**: 1,180 RON/capita (7% peste mediană)
**Link**: [short link]

**Ce face diferit**:
- **Investiții**: 28% din buget (vs. 15% mediană) - focus pe dezvoltare
- **Eficiență administrativă**: 12% pe administrație (vs. 20% mediană)
- **Venituri proprii**: 65% din venituri sunt fiscale proprii (vs. 45% mediană) - autonomie financiară

**Lecții pentru entitatea analizată**:
1. **Creșterea veniturilor proprii**: Orașul A a îmbunătățit colectarea impozitelor și a diversificat surse (ex. chirii spații publice, parteneriate PPP).
2. **Digitalizare**: A investit în e-guvernare, reducând costurile administrative.

**Recomandare**: Studiați modelul Orașului A pentru creșterea autonomiei financiare.

---

#### 2. [Nume Oraș B] (Rang 5 / 23)

[Similar pentru următorii top performers]
\`\`\`

---

### Etapa 7: Identificarea Slăbiciunilor și Oportunităților

**Format răspuns**:
\`\`\`
## Puncte Slabe Identificate

### 1. [Exemplu: Venituri proprii sub mediană]

**Observație**: Entitatea are 40% venituri fiscale proprii vs. 50% mediană peers.
**Impact**: Dependență mare de transferuri → vulnerabilitate la schimbări politice/economice.

**Cauze posibile**:
- Colectare slabă a impozitelor (restanțe mari)
- Bază fiscală mică (sărăcie, șomaj)
- Taxe locale prea mici (subevaluare proprietăți, cote minime)

**Recomandare**:
1. **Îmbunătățire colectare**: Digitalizare plăți, campanii de conștientizare, notificări automate
2. **Actualizare bază fiscală**: Re-evaluare proprietăți (multe sunt la valori din 2000-2010)
3. **Diversificare**: Chirii, taxe speciale, parteneriate publice-private

**Exemplu de la peers**: Orașul B a crescut colectarea cu 15% prin implementare plată online și reduceri pentru plată anticipată.

---

### 2. [Altă slăbiciune identificată]

[Continuă analiza]
\`\`\`

---

### Etapa 8: Rezumat Comparativ

**Format răspuns**:
\`\`\`
## Rezumat Executiv - Benchmarking

### Poziționare Generală

**Clasament**: Locul 8 din 23 peers (top 35%, percentila 65%)
**Verdict**: **Performanță peste medie**, dar există spațiu de îmbunătățire

---

### Puncte Forte (Devieri Pozitive)

✅ **Investiții ridicate** (+76% față de mediană): Strategie de dezvoltare clară
✅ **Eficiență administrativă** (-18% cheltuieli administrație): Aparat birocratic controlat
✅ **Atenție socială** (+80% asistență socială): Grijă pentru persoane vulnerabile
✅ **Educație prioritizată** (+37% față de mediană): Investiție în capital uman

---

### Puncte Slabe (Devieri Negative / Oportunități)

⚠️ **Dependență de transferuri**: 60% din venituri sunt transferuri (vs. 50% mediană)
⚠️ **Venituri proprii sub potențial**: Baza fiscală nu este exploatată optim
⚠️ **[Altă slăbiciune]**: [Detalii]

---

### Top 3 Recomandări

1. **Creșterea veniturilor proprii** (prioritate înaltă):
   - Implementați plata online a impozitelor (inspirație: Orașul B)
   - Re-evaluați baza fiscală (proprietăți, terenuri)
   - Diversificați surse: chirii, parteneriate, taxe speciale
   - **Obiectiv**: Creștere cu 10-15% în 2 ani

2. **Menținerea nivelului de investiții** (prioritate înaltă):
   - Investițiile de 23% sunt excelente - continuați
   - **Atenție la sustenabilitate**: Verificați că nu cresc prea mult datoriile
   - Căutați activ fonduri externe (UE, guvernamentale)

3. **Sharing best practices în educație** (prioritate medie):
   - Documentați și promovați modelul dvs. de finanțare educație
   - Participați la rețele de schimb experiență cu peers
   - Poate genera venituri suplimentare (consulting, training pentru alte entități)

---

### Link-uri Partajabile

**Profil entitate analizată**: [link]
**Ranking complet peers**: [link]
**Top performers**:
- [Oraș A]: [link]
- [Oraș B]: [link]
- [Oraș C]: [link]

**Actualizat**: [Data]
**An analizat**: ${analysisYear}
\`\`\`

---

## Note Finale pentru AI

1. **Toate comparațiile** trebuie să fie quantificate - folosește % și diferențe absolute
2. **Identifică cauzele** pentru fiecare deviație semnificativă - nu doar constată
3. **Echilibrat**: Evidențiază atât pozitivul cât și negativul - nu fii nici prea critic, nici prea lăudativ
4. **Acționabil**: Fiecare recomandare trebuie să fie concretă și implementabilă
5. **Link-uri obligatorii**: Include link-ul către ranking și profilele entităților menționate

---

**Începe analiza acum pentru CUI ${entity_cui}, anul ${analysisYear}, dimensiune comparație: ${comparison_dimension}.**
`;
}
