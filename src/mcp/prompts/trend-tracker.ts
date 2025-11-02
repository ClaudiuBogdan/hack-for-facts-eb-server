/**
 * MCP Prompt: Trend Tracker
 *
 * Analyzes multi-year budget evolution to identify trends, growth patterns,
 * and significant changes over time. Helps understand temporal dynamics
 * and predict future trajectories.
 */

export interface TrendTrackerArgs {
  entity_cui: string;
  start_year: number;
  end_year: number;
  focus_area?: string;
}

export function getTrendTrackerPrompt(args: TrendTrackerArgs): string {
  const { entity_cui, start_year, end_year, focus_area } = args;
  const yearRange = end_year - start_year + 1;

  return `
# Analiza Tendințelor Bugetare Multi-Anuale

Ești un expert în analiză financiară publică cu specializare în analize temporale și forecasting. Sarcina ta este să analizezi evoluția bugetară pentru entitatea **CUI ${entity_cui}** pe perioada **${start_year}-${end_year}** (${yearRange} ani).

${focus_area ? `**Focus special**: ${focus_area}` : ''}

## Obiective

1. Identifică trend-ul general (creștere, descreștere, stabilitate) pentru venituri și cheltuieli
2. Calculează rate de creștere an-cu-an (Year-over-Year)
3. Detectează schimbări bruște (>30% YoY) și investighează cauzele
4. Analizează reorientarea priorităților bugetare în timp
5. Compară trend-ul entității cu media regională/națională (dacă posibil)

---

## Stil de comunicare

- **Analitic**: Folosește termeni precum "trend crescător", "rată de creștere", "inflexiune", "volatilitate"
- **Temporal**: Pune accentul pe evoluție - "de la... la...", "creștere graduală", "salt brusc în..."
- **Explicativ**: Pentru fiecare schimbare majoră, oferă context și posibile cauze
- **Predictiv**: Unde este posibil, extrapolează trend-uri pentru anul următor

---

## Fluxul de analiză

### Etapa 1: Extragerea Datelor Anuale

**Acțiune**: Folosește \`query_timeseries_data\` pentru a obține seriile temporale de venituri și cheltuieli.

**Parametri**:
\`\`\`json
{
  "title": "Evoluția Bugetară ${start_year}-${end_year} - CUI ${entity_cui}",
  "period": {
    "type": "YEAR",
    "selection": {
      "interval": {
        "start": "${start_year}",
        "end": "${end_year}"
      }
    }
  },
  "series": [
    {
      "label": "Venituri Totale",
      "filter": {
        "accountCategory": "vn",
        "entityCuis": ["${entity_cui}"]
      }
    },
    {
      "label": "Cheltuieli Totale",
      "filter": {
        "accountCategory": "ch",
        "entityCuis": ["${entity_cui}"]
      }
    }
  ]
}
\`\`\`

${focus_area ? `
**Serii suplimentare pentru focus area "${focus_area}"**:
\`\`\`json
{
  "label": "${focus_area} - Cheltuieli",
  "filter": {
    "accountCategory": "ch",
    "entityCuis": ["${entity_cui}"],
    "functionalPrefixes": ["[cod funcțional din discover_filters]"]
  }
}
\`\`\`

**Notă**: Folosește \`discover_filters\` cu query="${focus_area}" pentru a obține codul funcțional corect.
` : ''}

**Output așteptat**:
- dataLink (link partajabil către grafic interactiv)
- dataSeries cu dataPoints pentru fiecare an
- statistics (min, max, avg, sum)

---

### Etapa 2: Calcularea Indicatorilor Temporali

**Acțiune**: Pe baza datelor obținute, calculează:

#### 2.1 Rate de Creștere An-cu-An (YoY - Year-over-Year)

**Formulă**: YoY(an) = ((Valoare_an - Valoare_an-1) / Valoare_an-1) × 100%

**Exemplu calcul**:
- ${start_year}: 10M RON
- ${start_year + 1}: 11.5M RON
- YoY ${start_year + 1}: ((11.5 - 10) / 10) × 100% = +15%

**Calculează pentru**:
- Venituri (fiecare an vs. an anterior)
- Cheltuieli (fiecare an vs. an anterior)
${focus_area ? `- ${focus_area} (dacă specificat)` : ''}

#### 2.2 Creștere Cumulativă (Perioada Totală)

**Formulă**: Creștere totală = ((Valoare_${end_year} - Valoare_${start_year}) / Valoare_${start_year}) × 100%

#### 2.3 Rata Medie de Creștere Anuală (CAGR - Compound Annual Growth Rate)

**Formulă**: CAGR = ((Valoare_finală / Valoare_inițială)^(1/număr_ani) - 1) × 100%

**Interpretare**: CAGR arată creșterea "medie" anuală, netezind fluctuațiile.

**Exemplu**:
- ${start_year}: 10M RON
- ${end_year}: 16.1M RON
- CAGR = ((16.1 / 10)^(1/${yearRange}) - 1) × 100% = +10% pe an (medie geometrică)

---

### Etapa 3: Prezentarea Evoluției Generale

**Format răspuns**:
\`\`\`
## Evoluția Bugetară ${start_year}-${end_year}

### Link Interactiv

[Vizualizează graficul complet: dataLink din query_timeseries_data]

### Tablou Sintetic

| An | Venituri (M RON) | YoY Venituri | Cheltuieli (M RON) | YoY Cheltuieli | Sold Bugetar |
|----|------------------|--------------|--------------------|--------------------|--------------|
| ${start_year} | 10.00 | - | 9.80 | - | +0.20 |
| ${start_year + 1} | 11.50 | +15.0% | 11.20 | +14.3% | +0.30 |
| ${start_year + 2} | 12.30 | +7.0% | 12.50 | +11.6% | -0.20 |
| ... | ... | ... | ... | ... | ... |
| ${end_year} | 16.10 | +8.5% | 16.50 | +10.0% | -0.40 |

**Creștere cumulativă (${start_year}-${end_year})**:
- **Venituri**: +61% (de la 10M la 16.1M RON)
- **Cheltuieli**: +68% (de la 9.8M la 16.5M RON)

**Rata medie de creștere anuală (CAGR)**:
- **Venituri**: +10.0% pe an
- **Cheltuieli**: +11.2% pe an

**Interpretare**: Bugetul a crescut susținut pe perioada analizată, cu o rată medie de ~10-11% anual. Cheltuielile au crescut ușor mai rapid decât veniturile, ducând la apariția de deficite moderate în anii recenți.
\`\`\`

---

### Etapa 4: Identificarea Schimbărilor Bruște

**Acțiune**: Identifică anii cu rate de creștere extreme (>+30% sau <-20%).

**Criterii de alertă**:
- **Salt major**: YoY > +30%
- **Scădere bruscă**: YoY < -20%
- **Reversare de trend**: Schimbare de la creștere la descreștere sau invers

**Format răspuns**:
\`\`\`
## Schimbări Semnificative Detectate

### 1. Salt Major în ${start_year + 2} - Venituri +45%

**Date**:
- ${start_year + 1}: 11.50M RON
- ${start_year + 2}: 16.68M RON
- **Creștere**: +5.18M RON (+45%)

**Investigare**:

Pentru a înțelege cauza, folosește \`get_entity_snapshot\` pentru anii ${start_year + 1} și ${start_year + 2} și compară:
- Structura veniturilor (fiscale vs. transferuri vs. împrumuturi)
- Evenimente externe (accesare fonduri UE? vânzare active? împrumuturi noi?)

**Explicații posibile**:
1. **Fond european**: Entitatea a accesat fonduri structurale UE pentru un proiect major
2. **Împrumut**: Contractare credit pentru investiții (Capitol 45 venituri)
3. **Transfer excepțional**: Sume majorate de la bugetul central/județean
4. **Vânzare active**: Valorificare terenuri/clădiri (Capitol 37 venituri)

**Verificare**:
[După analiza cu get_entity_snapshot]
- **Cauza identificată**: Accesare fonduri PNRR (Plan Național de Redresare și Reziliență) pentru modernizare școli - 5M RON venituri extraordinare.

**Sustenabilitate**: Creșterea este **nerecurentă** (legată de un proiect specific). Veniturile vor reveni la nivelul tendințial după finalizarea proiectului.

---

### 2. [Alte schimbări semnificative]

[Continuă pentru fiecare anomalie YoY]
\`\`\`

---

### Etapa 5: Analiza Reorientării Priorităților

${focus_area ? `
**Focus special pe domeniul: ${focus_area}**

**Acțiune**: Folosește \`query_timeseries_data\` pentru a extrage evoluția cheltuielilor pe domeniul ${focus_area} și compară cu evoluția totală.
` : ''}

**Acțiune generală**: Folosește \`analyze_entity_budget\` cu \`breakdown_by="overview"\` pentru 2-3 ani cheie (ex. ${start_year}, ${Math.floor((start_year + end_year) / 2)}, ${end_year}) pentru a vedea cum s-au schimbat prioritățile.

**Întrebări**:
1. Care categorii funcționale au crescut mai rapid decât media?
2. Care categorii au scăzut ca pondere din total?
3. Există o schimbare strategică vizibilă? (ex. de la funcționare la investiții, de la administrație la educație)

**Format răspuns**:
\`\`\`
## Evoluția Priorităților Bugetare

### Alocare pe Categorii Funcționale (Top 5)

| Categorie | ${start_year} | ${end_year} | Δ Valoare | Δ Pondere |
|-----------|------|------|-----------|-----------|
| Învățământ (65.) | 3.5M (35%) | 6.2M (38%) | +77% | +3pp |
| Servicii publice (54.) | 2.0M (20%) | 3.0M (18%) | +50% | -2pp |
| Administrație (51.) | 1.5M (15%) | 2.1M (13%) | +40% | -2pp |
| Sănătate (66.) | 1.0M (10%) | 2.5M (15%) | +150% | +5pp |
| Cultură (67.) | 0.8M (8%) | 1.2M (7%) | +50% | -1pp |

**Notă**: Δ Pondere = schimbare în puncte procentuale (pp)

**Observații**:

1. **Învățământul rămâne prioritatea #1** și crește atât în valoare absolută (+77%) cât și ca pondere (+3pp). Investiție constantă în educație.

2. **Sănătatea - creștere explozivă**: +150% în valoare și +5pp ca pondere. Posibile cauze:
   - Investiții în infrastructură sanitară (construcție dispensar, renovare policlinică)
   - Creșterea salariilor în sănătate (măsuri guvernamentale)
   - Pandemie COVID-19 (dacă perioada include 2020-2022)

3. **Administrația scade ca pondere**: Deși crește în valoare absolută (+40%), scade ca pondere din buget (-2pp). Semn de eficiență și prioritizare a serviciilor publice față de aparat administrativ.

4. **Serviciile publice cresc mai lent decât media**: +50% față de +68% total. Posibile explicații:
   - Eficientizare (ex. LED pentru iluminat → costuri mai mici)
   - Amânarea investițiilor în infrastructură
   - Transferarea unor servicii către companii private/regii

${focus_area ? `
---

### Focus: Evoluția Domeniului "${focus_area}"

[Detalii specifice pentru focus area]

**Trend**: [Crescător / Descrescător / Stabil]
**CAGR**: [%] pe an
**Deviere față de trend general**: [mai rapid / mai lent / similar]

**Interpretare**: [Explicație contextuală]
` : ''}
\`\`\`

---

### Etapa 6: Analiza Cheltuielilor de Dezvoltare vs. Funcționare

**Acțiune**: Extrage evoluția cheltuielilor pe categorii economice (salarii, bunuri, investiții) pentru a vedea dacă entitatea investește sau doar funcționează.

**Tool**: \`query_timeseries_data\` cu filtre economice:
- Capitol 10 (Salarii)
- Capitol 20 (Bunuri și servicii)
- Capitol 70 (Investiții)

**Format răspuns**:
\`\`\`
## Structura Economică - Evoluție

### Alocare pe Tipuri de Cheltuieli

| Categorie Economică | ${start_year} | ${end_year} | CAGR | Tendință |
|---------------------|------|------|------|----------|
| Salarii (10.) | 5.0M (51%) | 7.5M (45%) | +8.4% | ⬇️ Scădere ca pondere |
| Bunuri și servicii (20.) | 3.0M (31%) | 4.8M (29%) | +9.8% | ⬇️ Scădere ușoară ca pondere |
| Investiții (70.) | 1.5M (15%) | 3.8M (23%) | +20.3% | ⬆️ Creștere semnificativă |
| Altele (transferuri, etc.) | 0.3M (3%) | 0.4M (3%) | +5.9% | ➡️ Stabil |

**Interpretare**:

📈 **Investiții în creștere**: Entitatea alocă tot mai mult bugetului pentru investiții capitale (de la 15% la 23%), indicând o strategie de dezvoltare pe termen lung. CAGR de +20.3% pentru investiții vs. +11.2% general arată prioritizarea investițiilor.

📊 **Salarii - ponderea scade, dar valoarea crește**: Salariile cresc în termeni absoluți (+8.4%/an), dar scad ca pondere din buget (de la 51% la 45%). Aceasta este o evoluție pozitivă - arată că bugetul nu este "înghițit" de cheltuieli de personal, ci există spațiu pentru investiții.

⚠️ **Atenție la sustenabilitate**: Creșterea investițiilor este pozitivă, DAR verificați sursele de finanțare:
- Dacă sunt finanțate din împrumuturi → verificați capacitatea de rambursare
- Dacă sunt finanțate din fonduri UE → verificați ciclul de finanțare (se termină?)
- Dacă sunt din venituri proprii → excellent, sustenabil

**Recomandare**: Continuați trendul de investiții, dar asigurați-vă că există resurse pentru mentenanța activelor create (costurile de funcționare vor crește odată cu inaugurarea școlilor/drumurilor/spitalelor noi).
\`\`\`

---

### Etapa 7: Comparație cu Contextul Regional/Național

**Acțiune (opțional, dacă datele permit)**: Compară trend-ul entității cu media regională.

**Tool**: \`rank_entities\` pentru doi ani (${start_year} și ${end_year}) cu filtre pentru entități similare, apoi calculează CAGR mediu al grupului.

**Format răspuns**:
\`\`\`
## Comparație cu Contextul Regional

### Rata de Creștere - Entitate vs. Peers

**Grup de comparație**: [Orașe de mărime similară din regiunea X]

| Indicator | Entitatea analizată | Mediană grup peers | Deviere |
|-----------|---------------------|-------------------|---------|
| CAGR Venituri ${start_year}-${end_year} | +10.0% | +7.5% | +2.5pp |
| CAGR Cheltuieli ${start_year}-${end_year} | +11.2% | +8.0% | +3.2pp |
| CAGR Investiții ${start_year}-${end_year} | +20.3% | +12.0% | +8.3pp |

**Interpretare**: Entitatea crește mai rapid decât peers, în special la investiții (+8.3pp față de mediană). Acest lucru poate indica:
- **Pozitiv**: Strategie agresivă de dezvoltare, atragere fonduri externe, administrație proactivă
- **Atenție**: Verificați sustenabilitatea - creșterea rapidă poate ascunde creșterea datoriei publice

**Recomandare**: Comparați și evoluția datoriei publice (Capitolul 80 și 30) pentru a vă asigura că creșterea este sustenabilă.
\`\`\`

---

### Etapa 8: Predicție și Proiecție

**Acțiune**: Pe baza trend-ului identificat, proiectează valorile pentru anul următor (${end_year + 1}).

**Metode**:
1. **Extrapolere liniară**: Continuarea CAGR calculat
2. **Ajustare pentru evenimente**: Dacă știi că un proiect mare se termină, ajustează în jos

**Format răspuns**:
\`\`\`
## Proiecție pentru ${end_year + 1}

### Estimări Bazate pe Trend-uri

**Ipoteză**: Trendul CAGR din ${start_year}-${end_year} continuă în ${end_year + 1}.

| Indicator | ${end_year} (realizat) | ${end_year + 1} (proiecție) | Creștere estimată |
|-----------|----------|----------------|-------------------|
| Venituri | 16.10M RON | 17.71M RON | +10.0% (CAGR) |
| Cheltuieli | 16.50M RON | 18.35M RON | +11.2% (CAGR) |
| Deficit estimat | -0.40M RON | -0.64M RON | Creștere |

**Scenarii**:

1. **Scenariu optimist** (creștere economică, venituri fiscale peste așteptări):
   - Venituri: 18.5M RON (+15%)
   - Deficit: -0.35M RON (îmbunătățire)

2. **Scenariu de bază** (continuarea trend-ului actual):
   - Venituri: 17.71M RON (+10%)
   - Deficit: -0.64M RON (deteriorare ușoară)

3. **Scenariu pesimist** (criză economică, scădere colectare):
   - Venituri: 16.5M RON (+2.5%)
   - Deficit: -1.85M RON (deteriorare semnificativă)

**Recomandare**: Monitorizați execuția T1 ${end_year + 1} pentru a valida/ajusta proiecțiile. Dacă scenariul pesimist se materializează, pregătiți măsuri de ajustare (creștere venituri proprii, reducere cheltuieli discreționare).
\`\`\`

---

### Etapa 9: Rezumat și Concluzii

**Format răspuns**:
\`\`\`
## Rezumat Executiv - Analiza Temporală ${start_year}-${end_year}

### Trend General: [Creștere Susținută / Declin / Volatilitate / Stabilitate]

**Creștere cumulativă**:
- Venituri: +61% (${start_year}-${end_year})
- Cheltuieli: +68% (${start_year}-${end_year})

**Rata medie anuală**: ~10-11% CAGR

---

### Puncte Cheie

1. **Investiții în accelerare**: Ponderea investițiilor a crescut de la 15% la 23%, semnalând focalizare pe dezvoltare.

2. **Schimbare de prioritate către sănătate**: Cheltuielile pe sănătate au crescut cu +150%, devenind o prioritate majoră.

3. **Event major în ${start_year + 2}**: Salt de +45% la venituri datorat accesării fondurilor PNRR - nerecurent.

4. **Deficit moderat**: Deficitul s-a accentuat ușor în ultimii ani (0.20M → 0.40M), necesită monitorizare.

5. **Creștere peste medie regională**: Entitatea crește mai rapid (+3.2pp) decât peers, indicând dinamism și capacitate de atragere fonduri.

---

### Riscuri Identificate

⚠️ **Sustenabilitatea investițiilor**: Verificați dacă investițiile sunt finanțate din împrumuturi (risc creștere datorie).

⚠️ **Deficit crescător**: Deficitul tinde să crească - monitorizați și luați măsuri dacă depășește 10% din venituri.

⚠️ **Dependență de fonduri externe**: Dacă creșterea este bazată pe fonduri UE/PNRR, pregătiți plan pentru perioada post-finanțare.

---

### Oportunități

✅ **Capacitate de investiție**: Entitatea demonstrează capacitate de atragere și execuție fonduri pentru investiții.

✅ **Diversificare priorități**: Reorientare către sănătate arată adaptabilitate la nevoi emergente.

✅ **Creștere veniturilor proprii**: Dacă veniturile fiscale cresc peste mediană, aceasta indică dezvoltare economică locală.

---

### Link-uri Partajabile

**Grafic evoluție generală**: [dataLink din query_timeseries_data pentru venituri+cheltuieli]

${focus_area ? `**Grafic ${focus_area}**: [dataLink specific]` : ''}

**Snapshot-uri comparative**:
- Anul ${start_year}: [link din get_entity_snapshot]
- Anul ${end_year}: [link din get_entity_snapshot]

---

**Actualizat**: [Data curentă]
**Perioada analizată**: ${start_year}-${end_year} (${yearRange} ani)
\`\`\`

---

## Note Finale pentru AI

1. **Toate ratele de creștere** trebuie calculate și prezentate explicit - nu omite CAGR.
2. **Identifică cauzele** pentru fiecare salt/scădere >30% - nu lăsa neexplicate.
3. **Contextualizează**: Compară cu contexte externe (criză 2020, inflație, reforme, etc.).
4. **Link-uri obligatorii**: Include link către graficul principal și snapshots pentru ani cheie.
5. **Format numeric**: 1,234,567.89 RON (virgulă mii, punct zecimale), dual format (compact + full).

---

**Începe analiza acum pentru CUI ${entity_cui}, perioada ${start_year}-${end_year}${focus_area ? `, cu focus pe ${focus_area}` : ''}.**
`;
}
