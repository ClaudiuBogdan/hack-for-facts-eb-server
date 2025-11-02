/**
 * MCP Resource: Functional Classification Guide
 *
 * Provides detailed information about COFOG-based functional budget classifications
 * used in Romanian public budgets. Each code represents a specific government function
 * or service area.
 */

export const FUNCTIONAL_CLASSIFICATION_GUIDE = `
# Ghid de Clasificare Funcțională a Bugetului Public Român

## Ce este clasificarea funcțională?

Clasificarea funcțională grupează cheltuielile și veniturile bugetare în funcție de **scopul** pentru care sunt realizate. Este bazată pe standardul internațional COFOG (Classification of Functions of Government).

## Structura codurilor funcționale

Codurile sunt ierarhice, cu până la 6 niveluri de detaliere:
- **Capitol** (2 cifre): ex. "65" = Învățământ
- **Subcapitol** (4 cifre): ex. "65.10" = Învățământ primar
- **Clasificație** (6+ cifre): ex. "65.10.03" = Învățământ primar - servicii administrative

---

## Capitole Funcționale Principale

### 51. Autorități publice și acțiuni externe

**Definiție simplă**: Funcționarea instituțiilor de conducere a statului (Parlament, Guvern, Administrație Publică) și relațiile externe.

**Include**:
- 51.10 - Autorități publice executive și legislative
- 51.20 - Tranzacții privind datoria publică (dobânzi, comisioane)
- 51.30 - Transferuri cu caracter general între diferite nivele ale administrației
- 51.40 - Cercetare fundamentală
- 51.50 - Cercetare-dezvoltare în domeniul autorităților publice
- 51.60 - Alte servicii publice generale
- 51.70 - Acțiuni externe

**Notă**: Capitolul 51 include adesea transferuri între bugetele locale și central, care nu reprezintă cheltuieli finale.

---

### 54. Servicii și dezvoltare publică, locuințe, mediu și ape

**Definiție simplă**: Dezvoltarea comunităților, amenajarea teritoriului, protecția mediului, gestionarea apei și deșeurilor.

**Include**:
- 54.02 - Dezvoltare economică (proiecte regionale, fonduri UE)
- 54.10 - Locuințe (construcții de locuințe sociale, subvenții chirie)
- 54.20 - Servicii de utilitate publică (iluminat, salubritate)
- 54.30 - Protecția mediului și rezervații
- 54.40 - Servicii pentru resurse de apă

**Exemplu**: Construcția unui parc public, modernizarea iluminatului stradal, sau gestionarea deșeurilor intră în acest capitol.

---

### 61. Ordine publică și siguranță națională

**Definiție simplă**: Servicii de poliție, protecție civilă, siguranță națională, justiție și penitenciare.

**Include**:
- 61.10 - Poliție (poliția locală și națională)
- 61.20 - Ordine publică (jandarmerie, protecție civilă)
- 61.30 - Siguranță națională (servicii de informații)
- 61.40 - Justiție (instanțe, parchete)
- 61.50 - Penitenciare (închisori, detenție)

**Exemplu**: Salariile polițiștilor locali, echiparea secțiilor de pompieri, funcționarea instanțelor.

---

### 65. Învățământ

**Definiție simplă**: Toate serviciile educaționale, de la grădinițe până la universități, inclusiv cercetare academică.

**Include**:
- 65.10 - Învățământ preșcolar și primar
- 65.20 - Învățământ secundar (gimnazial și liceal)
- 65.30 - Învățământ profesional și tehnic
- 65.40 - Învățământ superior (universități)
- 65.50 - Învățământ postuniversitar (masterat, doctorat)
- 65.60 - Servicii auxiliare pentru învățământ (cantine, transport școlar, burse)

**Notă**: Educația reprezintă adesea cea mai mare categorie de cheltuieli pentru administrațiile locale (primării, consilii județene).

**Exemplu**: Salarii profesori, reabilitare școli, burse elevi, cantine școlare.

---

### 66. Sănătate

**Definiție simplă**: Servicii medicale, spitalicești, preventive și de sănătate publică.

**Include**:
- 66.10 - Produse, aparate și echipamente medicale
- 66.20 - Servicii de ambulatoriu (policlinici, cabinete medicale)
- 66.30 - Servicii de spital (spitale județene, clinici)
- 66.40 - Servicii de sănătate publică (prevenție, epidemiologie)
- 66.50 - Cercetare-dezvoltare în domeniul sănătății
- 66.60 - Alte servicii în domeniul sănătății

**Exemplu**: Construcția unui spital, achiziție echipamente medicale, salarii medici, campanii de vaccinare.

---

### 67. Cultură, recreere și religie

**Definiție simplă**: Servicii culturale, artă, biblioteci, sport, turism și sprijin pentru culte.

**Include**:
- 67.10 - Servicii culturale (teatre, muzee, biblioteci, case de cultură)
- 67.20 - Servicii recreative și sportive (săli de sport, baze sportive)
- 67.30 - Servicii difuzate prin mass-media (radio, TV publice)
- 67.40 - Servicii religioase (reparații lăcașuri de cult, salarii personal)
- 67.50 - Cercetare-dezvoltare în cultură și religie

**Exemplu**: Organizarea unui festival cultural, reabilitarea unei case de cultură, construcția unei baze sportive.

---

### 68. Asigurări și asistență socială

**Definiție simplă**: Protecție socială, ajutoare, pensii, indemnizații, servicii pentru persoane vulnerabile.

**Include**:
- 68.10 - Asigurări și asistență în caz de boală și invaliditate
- 68.20 - Asigurări și asistență pentru familie și copii (alocații, indemnizații)
- 68.30 - Asigurări și asistență pentru șomaj
- 68.40 - Asigurări și asistență pentru locuință (ajutoare chirie)
- 68.50 - Asigurări și asistență pentru persoane vârstnice (pensii, cămine)
- 68.60 - Asigurări și asistență pentru persoane excluse (ajutoare sociale)
- 68.70 - Cercetare-dezvoltare în protecție socială

**Exemplu**: Ajutoare sociale, alocații pentru copii, servicii în centre de zi pentru vârstnici, ajutoare pentru încălzire.

---

### 70. Locuințe, servicii și dezvoltare publică

**Definiție simplă**: Infrastructură economică, transport, agricultură, energie, comunicații.

**Include**:
- 70.10 - Agricultură, silvicultură, piscicultură
- 70.20 - Combustibili și energie
- 70.30 - Minerit, industrie și construcții
- 70.40 - Transport (drumuri, poduri, transport public)
- 70.50 - Comunicații și tehnologia informației
- 70.60 - Alte servicii economice (comerț, turism)

**Exemplu**: Modernizarea unui drum județean, subvenții transport public, dezvoltarea infrastructurii IT.

---

### 80. Rezerve

**Definiție simplă**: Fonduri de rezervă pentru situații neprevăzute sau urgențe.

**Include**:
- 80.10 - Fond de rezervă bugetară
- 80.20 - Fond de intervenție

**Notă**: Aceste fonduri sunt alocate la începutul anului și utilizate pe parcurs pentru situații neprevăzute (calamități, urgențe).

---

### 81. Plăți ale serviciului datoriei publice

**Definiție simplă**: Dobânzi și comisioane pentru împrumuturile contractate de entitatea publică.

**Include**:
- 81.10 - Plăți de dobânzi pentru datoria publică internă
- 81.20 - Plăți de dobânzi pentru datoria publică externă

**Notă**: Nu include rambursarea principalului (suma împrumutată), ci doar costul creditelor (dobânzile).

---

### 84. Transferuri cu destinație specială

**Definiție simplă**: Transferuri de la bugetul central sau județean către alte entități, cu scop predefinit.

**Include**:
- 84.10 - Transferuri între unități ale administrației publice
- 84.20 - Transferuri către instituții publice

**Notă**: Similar cu capitolul 51.30, reprezintă mișcări de fonduri între bugete, nu cheltuieli finale.

---

## Cum se folosesc codurile funcționale?

1. **Pentru analiza priorităților**: Codurile funcționale arată unde își alocă o entitate resursele (educație, sănătate, infrastructură).

2. **Pentru comparații**: Poți compara două primării să vezi cât cheltuiesc fiecare pe educație (cod 65.).

3. **Pentru evoluție în timp**: Urmărește cum se schimbă alocările pe ani (crește sau scade investiția în sănătate?).

4. **Pentru drill-down**: Începi cu capitol (ex. 65.), apoi intri în subcapitol (65.10), apoi în clasificație (65.10.03).

---

## Exemple practice de utilizare

**Exemplu 1**: Cât cheltuiește Municipiul Cluj-Napoca pe educație?
- Cod funcțional: **65.** (toate subcategoriile de învățământ)

**Exemplu 2**: Care primării investesc cel mai mult în transport public per capita?
- Cod funcțional: **70.40** (Transport)
- Normalizare: per capita

**Exemplu 3**: Cum au evoluat cheltuielile cu protecția mediului în județul Brașov între 2020-2024?
- Cod funcțional: **54.30** (Protecția mediului)
- Agregare: la nivel de județ
- Perioadă: 2020-2024

---

## Note importante

- **Prefixele** (cod cu punct final, ex. "65.") selectează TOATE subcategoriile din acel capitol
- **Codurile exacte** (fără punct final, ex. "65.10.03") selectează DOAR acea clasificație specifică
- Codurile funcționale răspund la întrebarea **"PENTRU CE?"** se cheltuie banii (vs. coduri economice care răspund la **"PE CE?"**)

---

**Surse**:
- Clasificațiile bugetare - Ministerul Finanțelor: https://mfinante.gov.ro/en/domenii/buget/clasificatiile-bugetare
- COFOG Manual - Eurostat
`;

export function getFunctionalClassificationGuide(): string {
  return FUNCTIONAL_CLASSIFICATION_GUIDE;
}
