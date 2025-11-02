/**
 * MCP Resource: Financial Terms Glossary
 *
 * Provides simple explanations for common budget analysis and public finance terms.
 * All terms are explained in accessible Romanian language, avoiding unnecessary jargon.
 */

export const FINANCIAL_TERMS_GLOSSARY = `
# Glosar de Termeni Financiari - Bugetul Public

## Introducere

Acest glosar explică termenii folosiți frecvent în analiza bugetelor publice, în limbaj simplu și accesibil. Fiecare termen este explicat cu exemple concrete din contextul românesc.

---

## Termeni Generali

### Buget public
**Definiție**: Planul financiar anual care cuprinde toate veniturile (încasările) și cheltuielile (plățile) estimate pentru o instituție publică.

**Explicație simplă**: Bugetul este ca un "plan de cheltuieli" pentru o familie, dar la nivel de instituție publică. Arată de unde vin banii și pe ce se cheltuie.

**Exemplu**: Bugetul Municipiului Cluj-Napoca pentru 2024 arată că primăria estimează venituri de 2 miliarde RON și cheltuieli de 2.1 miliarde RON.

---

### Execuție bugetară
**Definiție**: Realizarea efectivă a veniturilor și cheltuielilor pe parcursul anului fiscal, comparativ cu ceea ce a fost planificat (bugetat).

**Explicație simplă**: Este diferența dintre "ce am plănuit" (bugetul aprobat) și "ce s-a întâmplat efectiv" (încasări și plăți reale).

**Indicatori**:
- **Grad de execuție venituri**: (Venituri realizate / Venituri bugetate) × 100%
- **Grad de execuție cheltuieli**: (Cheltuieli realizate / Cheltuieli bugetate) × 100%

**Exemplu**: Dacă o primărie a bugetat 100M RON cheltuieli și a cheltuit efectiv 85M RON, gradul de execuție este 85%.

**Normal**: Un grad de execuție între 85-95% este considerat bun (nici prea mic = subutilizare, nici >100% = depășire buget).

---

### Venituri bugetare
**Definiție**: Toate sumele de bani încasate de o instituție publică în cursul unui an.

**Categorii principale**:
1. **Venituri fiscale** (impozite și taxe): impozit pe clădiri, impozit pe teren, taxe locale
2. **Venituri nefiscale**: chirii, amenzi, servicii
3. **Transferuri**: bani primiți de la bugetul de stat sau județean
4. **Împrumuturi**: credite contractate (atenție: trebuie rambursate!)

**Exemplu**: O primărie poate avea venituri din:
- Impozit pe clădiri plătit de cetățeni: 10M RON
- Transferuri de la bugetul de stat: 30M RON
- Chirii pentru spații publice: 2M RON
- Total venituri: 42M RON

---

### Cheltuieli bugetare
**Definiție**: Toate plățile efectuate de o instituție publică pentru a-și îndeplini atribuțiile.

**Categorii principale**:
1. **Cheltuieli curente**: Salarii, utilități, întreținere (costuri repetitive)
2. **Cheltuieli de capital**: Investiții (construcții, echipamente) - creează active durabile

**Exemplu**: Cheltuielile unei școli includ:
- Salarii profesori (cheltuială curentă): 5M RON
- Utilități - încălzit, apă, curent (cheltuială curentă): 500K RON
- Renovare corp de clădire (cheltuială de capital): 2M RON

---

### Deficit bugetar
**Definiție**: Situația în care cheltuielile depășesc veniturile într-o perioadă dată.

**Formulă**: Deficit = Cheltuieli - Venituri (rezultat negativ)

**Explicație simplă**: Este ca și cum ai cheltui mai mult decât câștigi - diferența trebuie acoperită din economii (rezerve) sau împrumuturi.

**Exemplu**:
- Venituri: 100M RON
- Cheltuieli: 110M RON
- Deficit: -10M RON (sau 10%)

**Consecințe**:
- Deficite moderate pot fi normale pentru investiții mari
- Deficite cronice mari duc la creșterea datoriei și probleme financiare

---

### Excedent bugetar
**Definiție**: Situația în care veniturile depășesc cheltuielile.

**Formulă**: Excedent = Venituri - Cheltuieli (rezultat pozitiv)

**Explicație simplă**: Rămân bani "în plus" care pot fi economisiți sau investiți.

**Exemplu**:
- Venituri: 120M RON
- Cheltuieli: 100M RON
- Excedent: 20M RON

**Ce se întâmplă cu excedentul?**:
- Poate fi reportat pentru anul următor
- Poate fi folosit pentru investiții suplimentare
- Poate reduce nevoia de împrumuturi

---

## Termeni de Analiză

### Per capita
**Definiție**: "Pe cap de locuitor" - împărțirea unei sume totale la numărul de locuitori.

**Formulă**: Valoare per capita = Valoare totală / Populația

**De ce este utilă**: Permite compararea echitabilă între entități de dimensiuni diferite.

**Exemplu**:
- Municipiul A: 100M RON cheltuieli, 100,000 locuitori → 1,000 RON per capita
- Orașul B: 10M RON cheltuieli, 20,000 locuitori → 500 RON per capita
- Concluzie: Municipiul A cheltuiește dublu per capita față de Orașul B

**Când se folosește**: Pentru comparații între primării, județe, regiuni de dimensiuni diferite.

---

### Outlier (Valoare atipică / Anomalie)
**Definiție**: O entitate sau valoare care deviază semnificativ de la norma sau media grupului.

**Explicație simplă**: Este "oaia neagră" - ceva care iese din comun, fie în bine, fie în rău.

**Identificare**: De obicei, se consideră outlier o valoare care este:
- Mai mare de 2× media/mediană, sau
- Mai mică de 0.5× media/mediană

**Exemplu**:
- Majoritatea primăriilor cheltuie 500-700 RON per capita pe educație
- Primăria X cheltuiește 1,500 RON per capita → Outlier (pozitiv - investește mult)
- Primăria Y cheltuiește 200 RON per capita → Outlier (negativ - investește puțin)

**Ce înseamnă**: Outliers merită investigați - pot indica:
- Bune practici (outlier pozitiv)
- Probleme sau ineficiență (outlier negativ)
- Circumstanțe speciale (ex. o comună turistică are venituri mari per capita)

---

### Mediană
**Definiție**: Valoarea din mijlocul unui set de date ordonat crescător.

**Diferență față de medie (average)**: Mediana nu este influențată de valori extreme (outliers).

**Exemplu**:
- Cheltuieli per capita pentru 5 primării: 400, 450, 500, 520, 2000 RON
- **Media**: (400+450+500+520+2000)/5 = 774 RON (distorsionată de 2000)
- **Mediana**: 500 RON (valoarea din mijloc - mai reprezentativă)

**Când se folosește**: Preferabil față de medie când există outliers.

---

### Deviație standard (Standard deviation)
**Definiție**: Măsoară cât de dispersate sunt valorile față de medie.

**Explicație simplă**: Arată cât de "împrăștiate" sunt datele - deviație mică = valori apropiate, deviație mare = valori foarte variate.

**Folosire în identificarea outliers**:
- Valori > Media + 2×Deviație → Outlier superior
- Valori < Media - 2×Deviație → Outlier inferior

**Exemplu**:
- Grupa A (cheltuieli primării): 500, 520, 480, 510, 490 RON/capita → Deviație mică (~15) - toate primăriile cheltuie similar
- Grupa B: 300, 800, 400, 1000, 200 RON/capita → Deviație mare (~300) - mari diferențe între primării

---

### Rată de creștere (Growth rate / YoY)
**Definiție**: Procentul cu care o valoare crește sau scade de la un an la altul.

**Formulă**: Rată creștere = ((An curent - An anterior) / An anterior) × 100%

**Exemplu**:
- 2023: 100M RON cheltuieli
- 2024: 115M RON cheltuieli
- Rată de creștere: ((115-100)/100) × 100% = 15%

**Interpretare**:
- Rată pozitivă: creștere
- Rată negativă: scădere
- Rata > 20%: creștere rapidă (merită investigată cauza)
- Rata < -20%: scădere bruscă (posibil semnal de problemă)

**YoY** = Year-over-Year = comparație față de anul precedent

---

### Trend (Tendință)
**Definiție**: Direcția generală de evoluție a unei valori pe o perioadă lungă.

**Tipuri de trenduri**:
- **Crescător**: Valorile cresc constant (ex. cheltuielile cu sănătatea cresc anual)
- **Descrescător**: Valorile scad constant (ex. datoria publică scade)
- **Stabil**: Valorile rămân aproximativ constante
- **Ciclică**: Valorile urcă și coboară periodic

**Exemplu**:
- Cheltuieli cu educația: 2020=100M, 2021=105M, 2022=110M, 2023=115M, 2024=120M
- **Trend**: Crescător constant, +5M pe an (5% creștere anuală)

**Utilitate**: Trendurile ajută la:
- Predicții pentru anii viitori
- Identificarea schimbărilor de politică
- Evaluarea sustenabilității

---

## Termeni Contabile

### Angajamente bugetare
**Definiție**: Contracte sau obligații legale care vor genera plăți în viitor.

**Explicație simplă**: Este ca și cum ai semna un contract pentru a cumpăra ceva - banii nu au plecat încă din cont, dar ai obligația să plătești.

**Exemplu**:
- Primăria semnează contract pentru construcția unei școli: 10M RON
- Angajament bugetar: 10M RON (obligația de a plăti)
- Plăți efective: Se fac treptat, pe măsură ce lucrările avansează

**De ce contează**: Angajamentele arată obligațiile viitoare, chiar dacă banii nu au fost plătiți încă.

---

### Plăți efective
**Definiție**: Transferurile concrete de bani din contul instituției publice.

**Diferență față de angajamente**: Angajamentul = "am promis să plătesc", Plata = "am plătit efectiv".

**Exemplu**:
- Contract construit școală: 10M RON (angajament)
- După 6 luni, constructor finalizează 50% → Primăria plătește 5M RON (plată efectivă)

---

### Credite bugetare
**Definiție**: Sumele maxime aprobate în buget pentru anumite destinații.

**ATENȚIE**: "Credite bugetare" ≠ "împrumuturi/credite bancare"!

**Explicație simplă**: Este "limita de cheltuieli" aprobată de consiliu pentru fiecare categorie.

**Exemplu**:
- Credit bugetar pentru educație: 50M RON
- Înseamnă: Primăria poate cheltui MAXIMUM 50M RON pe educație în anul respectiv
- Nu poate depăși această sumă fără o rectificare bugetară (aprobare consiliu)

---

### Rectificare bugetară
**Definiție**: Modificarea bugetului inițial pe parcursul anului fiscal.

**Când este necesară**:
- Venituri mai mari/mai mici decât estimate
- Cheltuieli neprevăzute (calamități, urgențe)
- Redistribuire între categorii de cheltuieli

**Procedură**: Necesită aprobare de consiliul local/județean.

**Exemplu**:
- Buget inițial educație: 50M RON
- La rectificare (septembrie): se majorează la 55M RON (pentru reparații urgente)

---

## Termeni Fiscali

### Impozit
**Definiție**: Sumă de bani obligatorie, plătită de cetățeni sau companii către stat, fără contraprestaţie directă.

**Explicație simplă**: Plătești impozit și banii merg în bugetul public pentru servicii generale (drumuri, școli, spitale), nu primești ceva direct în schimb.

**Exemple**:
- Impozit pe clădiri (persoane fizice)
- Impozit pe profit (companii)
- Impozit pe venit

**Diferență față de taxă**: Impozitul este general, taxa este pentru un serviciu specific.

---

### Taxă
**Definiție**: Sumă de bani plătită pentru un serviciu public specific.

**Explicație simplă**: Plătești taxa și primești direct un serviciu în schimb.

**Exemple**:
- Taxă de eliberare pașaport
- Taxă de salubrizare (ridicare gunoi)
- Taxă de timbru

---

### Cotă defalcată din impozite
**Definiție**: Procent dintr-un impozit colectat la nivel central care se redistribuie către bugetele locale.

**Explicație simplă**: Statul colectează unele impozite (ex. impozit pe venit, TVA) și apoi împarte o parte din ele cu primăriile și județele.

**Exemplu**:
- TVA colectată la nivel național: 100 miliarde RON
- Cota defalcată pentru bugetele locale: 9% = 9 miliarde RON
- Fiecare primărie primește o parte proporțională cu populația și alte criterii

**De ce există**: Unele impozite sunt mai eficient colectate central, apoi redistribuite.

---

## Termeni de Datorie Publică

### Datorie publică
**Definiție**: Totalul împrumuturilor contractate de o instituție publică și încă nerambursate.

**Explicație simplă**: Banii pe care o primărie, județ sau statul îi datorează băncilor sau altor creditori.

**Componente**:
- **Principal**: Suma împrumutată inițial
- **Dobânzi**: Costul creditului (se plătesc anual sau periodic)

**Exemplu**:
- Primăria A împrumută 50M RON pentru construcția unui spital
- Datorie publică: 50M RON (principalul)
- În buget vor apărea anual:
  - Capitol 30 (Dobânzi): ex. 2M RON/an
  - Capitol 80 (Rambursări): ex. 5M RON/an

---

### Serviciul datoriei
**Definiție**: Totalul plăților anuale pentru datorie = Rambursări (principal) + Dobânzi.

**Formulă**: Serviciul datoriei = Rambursări + Dobânzi

**Exemplu**:
- Rambursări anuale: 5M RON
- Dobânzi anuale: 2M RON
- Serviciul datoriei: 7M RON

**Indicator de sustenabilitate**:
- Serviciul datoriei / Venituri totale < 15% → OK
- Serviciul datoriei / Venituri totale > 30% → Risc mare

---

### Capacitate/Necesitate de finanțare
**Definiție**:
- **Capacitate de finanțare** (surplus): Venituri > Cheltuieli curente + investiții → Rămân bani
- **Necesitate de finanțare** (deficit): Cheltuieli > Venituri → Lipsesc bani

**Explicație simplă**:
- Capacitate = poți economisi sau investi mai mult
- Necesitate = trebuie să împrumuți sau să tai cheltuieli

---

## Termeni de Investiții

### Cheltuieli de capital
**Definiție**: Cheltuieli pentru achiziționarea sau construcția de active cu durată lungă de viață (>1 an).

**Include**: Clădiri, drumuri, echipamente, infrastructură

**Capitol economic**: 70.

**Caracteristici**:
- Creează valoare pe termen lung
- Se amortizează în timp
- Necesită adesea finanțare prin împrumuturi sau fonduri UE

**Exemplu**: Construcția unui spital, modernizarea unui drum, achiziția autobuzelor pentru transport public.

---

### Cheltuieli curente
**Definiție**: Cheltuieli pentru funcționarea zilnică, care se repetă anual.

**Include**: Salarii, utilități, întreținere, materiale consumabile

**Capitole economice**: 10-59

**Caracteristici**:
- Necesare pentru menținerea activității
- Se consumă imediat
- Trebuie acoperite din venituri curente

**Exemplu**: Salarii profesori, facturi energie electrică, materiale de curățenie.

---

### Investiție publică
**Definiție**: Proiect de construcție sau achiziție de infrastructură finanțat din bugetul public.

**Etape**:
1. **Planificare**: Studiu de fezabilitate, proiect tehnic
2. **Finanțare**: Alocare bugetară, credite, fonduri UE
3. **Execuție**: Licitație, contract, construcție
4. **Recepție**: Finalizare și punere în funcțiune

**Exemple**: Construcție școală, reabilitare drum, modernizare rețea de apă.

---

## Termeni de Comparație

### Benchmarking
**Definiție**: Compararea performanței unei entități cu cele similare (peers) pentru identificarea diferențelor și best practices.

**Explicație simplă**: "Cum stau eu față de alții similari cu mine?"

**Exemplu**:
- Primăria X compară cheltuielile per capita cu alte 10 primării de dimensiune similară
- Descoperă că cheltuie dublu pe administrație → Investighează de ce și caută soluții

---

### Eficiență
**Definiție**: Raportul între rezultate (output) și resurse consumate (input).

**Formulă simplificată**: Eficiență = Output / Input

**Exemplu**:
- Primăria A: 100 tone gunoi colectat, cost 1M RON → Eficiență: 100 tone/M RON
- Primăria B: 80 tone gunoi colectat, cost 1M RON → Eficiență: 80 tone/M RON
- Primăria A este mai eficientă

**În analize bugetare**: Căutăm entități care obțin rezultate bune cu costuri mici.

---

## Note Finale

### Cum să folosești acest glosar:

1. **Pentru înțelegerea rapoartelor**: Când vezi un termen necunoscut într-o analiză bugetară, verifică aici.
2. **Pentru comparații**: Folosește termenii corect când compari entități (per capita, mediană, trend).
3. **Pentru comunicare**: Explică datele bugetare folosind termenii din glosar, astfel încât oricine să înțeleagă.

### Principii de bază:

- **Transparență**: Toți termenii pot fi explicați simplu - nu există mister în bugetul public.
- **Comparabilitate**: Folosirea termenilor standard permite comparații corecte.
- **Context**: Termenii capătă sens în context - un deficit de 5% poate fi OK pentru o investiție mare, dar problematic dacă este cronic.

---

**Actualizat**: Noiembrie 2024
**Surse**: Legislația română (Legea 500/2002), standardele internaționale (IPSAS, ESA 2010), practica de analiză financiară publică.
`;

export function getFinancialTermsGlossary(): string {
  return FINANCIAL_TERMS_GLOSSARY;
}
