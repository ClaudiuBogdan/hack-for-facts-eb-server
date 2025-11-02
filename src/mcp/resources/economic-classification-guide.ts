/**
 * MCP Resource: Economic Classification Guide
 *
 * Provides detailed information about economic budget classifications
 * used in Romanian public budgets. Each code represents a type of expense
 * or revenue (salaries, goods, services, investments, etc.).
 */

export const ECONOMIC_CLASSIFICATION_GUIDE = `
# Ghid de Clasificare Economică a Bugetului Public Român

## Ce este clasificarea economică?

Clasificarea economică grupează cheltuielile și veniturile bugetare în funcție de **natura economică** a tranzacției - adică **PE CE** se cheltuiesc banii sau **DE UNDE** vin veniturile.

Spre deosebire de clasificarea funcțională (care arată SCOPUL - educație, sănătate), clasificarea economică arată TIPUL de cheltuială (salarii, bunuri, investiții).

## Structura codurilor economice

Codurile sunt ierarhice:
- **Capitol** (2 cifre): ex. "10" = Cheltuieli de personal
- **Articol** (2 cifre): ex. "10.01" = Salarii
- **Alineat** (2 cifre): ex. "10.01.01" = Salarii de bază

Format complet: **XX.YY.ZZ** (capitol.articol.alineat)

---

## CHELTUIELI (Expense Codes)

### Capitol 10 - Cheltuieli de personal

**Definiție simplă**: Toate costurile cu angajații (salarii, contribuții sociale, alte beneficii).

**Include**:
- **10.01** - Salarii de bază
  - Salariile lunare ale angajaților din sectorul bugetar
- **10.02** - Salarii de merit, indemnizații
  - Sporuri pentru performanță, vechime, condiții dificile
- **10.03** - Indemnizații plătite unor persoane din afara unității
  - Colaboratori, consultanți externi pe contract temporar
- **10.04** - Contribuții asigurări sociale
  - Contribuții pentru pensii, sănătate plătite de angajator
- **10.06** - Alte drepturi salariale în bani
  - Tichete de masă, prime de vacanță, alte beneficii

**Notă**: Cheltuielile de personal sunt adesea cea mai mare categorie economică pentru instituțiile publice (50-70% din buget).

**Exemplu**: Salariul unui profesor, contribuțiile sociale ale primăriei pentru angajați, tichete de masă.

---

### Capitol 20 - Bunuri și servicii

**Definiție simplă**: Achiziții curente necesare funcționării zilnice (utilități, materiale, servicii, deplasări).

**Include**:
- **20.01** - Bunuri și servicii
  - **20.01.01** - Furnituri de birou
  - **20.01.02** - Materiale pentru curățenie
  - **20.01.03** - Încălzit, iluminat, forță motrică (energie electrică, gaze, apă)
  - **20.01.04** - Carburanți și lubrifianți
  - **20.01.05** - Piese de schimb
  - **20.01.06** - Transport
  - **20.01.07** - Poștă, telecomunicații, internet, radio, tv, presă
  - **20.01.08** - Materiale și prestări de servicii cu caracter funcțional
  - **20.01.09** - Alte bunuri și servicii pentru întreținere și funcționare
  - **20.01.30** - Reparații curente

- **20.02** - Reparații curente
  - Reparații ale clădirilor, instalațiilor, echipamentelor (nu investiții capitale)

- **20.03** - Bunuri de natura obiectelor de inventar
  - Mobilier, aparatură electronică, echipamente sub pragul de investiție

- **20.04** - Deplasări, detașări, transferări
  - Costuri de deplasare în interes de serviciu (transport, cazare, diurnă)

- **20.05** - Cărți, publicații și materiale documentare
  - Abonamente, cărți, reviste, documentație tehnică

- **20.06** - Consultanță și expertiză
  - Servicii de consultanță juridică, tehnică, financiară, audit

- **20.09** - Alte cheltuieli cu bunuri și servicii
  - Protocol, reclamă, comunicare publică

**Exemplu**: Plata facturii de energie electrică pentru o școală, achiziția de materiale de curățenie, reparația acoperișului unei primării.

---

### Capitol 30 - Dobânzi

**Definiție simplă**: Costurile cu dobânzile pentru împrumuturile contractate.

**Include**:
- **30.01** - Dobânzi aferente datoriei publice interne
  - Dobânzi pentru credite contractate în România (RON)
- **30.02** - Dobânzi aferente datoriei publice externe
  - Dobânzi pentru credite internaționale (EUR, USD)
- **30.03** - Alte cheltuieli cu dobânzi
  - Comisioane bancare, penalități

**Notă**: Nu include rambursarea principalului (suma împrumutată), ci doar costul împrumutului.

**Exemplu**: Dobânda la un credit contractat pentru construcția unui spital.

---

### Capitol 40 - Subvenții

**Definiție simplă**: Ajutoare financiare acordate întreprinderilor publice sau private pentru anumite activități.

**Include**:
- **40.01** - Subvenții pentru instituții publice
  - Sprijin financiar pentru spitale, teatre, muzee
- **40.02** - Subvenții pentru companii și societăți comerciale
  - Subvenții pentru transport public, termoficare, energie
- **40.03** - Subvenții pentru instituții private
  - Sprijin pentru ONG-uri, fundații cu activitate publică

**Exemplu**: Subvenție pentru compania de transport public local, sprijin pentru teatrul municipal.

---

### Capitol 50 - Transferuri între unități ale administrației publice

**Definiție simplă**: Fonduri transferate între diferite nivele de administrație (central → local, județ → comună).

**Include**:
- **50.01** - Transferuri către instituții publice
- **50.02** - Transferuri către bugetul de stat
- **50.04** - Transferuri din bugetul de stat către bugetele locale

**Notă**: Aceste transferuri nu reprezintă cheltuieli finale - sunt redistribuiri între bugete.

**Exemplu**: Transfer de la Consiliul Județean către o școală din subordine.

---

### Capitol 51 - Transferuri către instituții publice

**Definiție simplă**: Fonduri acordate instituțiilor publice (spitale, universități, teatre) din subordine sau colaboratoare.

**Include**:
- **51.01** - Transferuri curente (pentru funcționare)
- **51.02** - Transferuri de capital (pentru investiții)

**Exemplu**: Transfer pentru funcționarea unui muzeu din subordinea primăriei.

---

### Capitol 55 - Transferuri către alte unități ale administrației publice

**Definiție simplă**: Transferuri către alte entități publice, inclusiv bugete locale.

**Include**:
- **55.01** - Transferuri curente
- **55.02** - Transferuri de capital

**Exemplu**: Transfer de la consiliul județean către primăriile din județ pentru cofinanțarea unui proiect.

---

### Capitol 57 - Transferuri către persoane

**Definiție simplă**: Ajutoare sociale, burse, alocații acordate direct persoanelor fizice.

**Include**:
- **57.01** - Ajutoare sociale (pentru persoane defavorizate, vârstnici)
- **57.02** - Burse (pentru elevi, studenți)
- **57.03** - Indemnizații de asigurări sociale de sănătate
- **57.04** - Alte transferuri (alocații, indemnizații)

**Exemplu**: Ajutor social pentru o familie cu venit scăzut, bursă pentru un elev cu rezultate deosebite.

---

### Capitol 59 - Alte transferuri

**Definiție simplă**: Alte tipuri de transferuri care nu se încadrează în categoriile anterioare.

**Include**:
- **59.01** - Transferuri către organizații internaționale
- **59.02** - Ajutoare externe
- **59.15** - Contribuții la bugetul Uniunii Europene

**Exemplu**: Cotizații la organizații internaționale, contribuții la bugetul UE.

---

### Capitol 70 - Cheltuieli de capital (Investiții)

**Definiție simplă**: Cheltuieli pentru construcții, achiziții de echipamente și infrastructură cu durată lungă de viață.

**Include**:
- **70.01** - Active fixe (clădiri, terenuri, infrastructură)
  - **70.01.01** - Construcții (clădiri noi, reabilitări majore)
  - **70.01.02** - Mașini, echipamente, mijloace de transport
  - **70.01.03** - Mobilier, aparatură birotică, alte active corporale

- **70.02** - Stocuri (rezerve strategice)

- **70.03** - Rezerve de stat și de mobilizare

- **70.06** - Investiții ale regiilor autonome

**Notă**: Cheltuielile de capital creează active pe termen lung (școli, spitale, drumuri) spre deosebire de cheltuielile curente (salarii, utilități).

**Diferență cheie**:
- **Reparații curente** (20.02): mentenanță, reparații mici → Capitol 20
- **Investiții capitale** (70.01): construcții noi, modernizări majore → Capitol 70

**Exemplu**: Construcția unui nou spital, achiziția unui autobuz pentru transportul școlar, modernizarea unui drum județean.

---

### Capitol 79 - Plăți efectuate în anii precedenți și recuperate în anul curent

**Definiție simplă**: Corectări contabile pentru cheltuieli din anii anteriori care sunt recuperate.

**Include**:
- **79.01** - Plăți efectuate în anii precedenți și recuperate în anul curent

**Notă**: Categorie tehnică contabilă, rar întâlnită în analize.

---

### Capitol 80 - Rambursări de credite

**Definiție simplă**: Rambursarea sumelor împrumutate (principalul împrumutului).

**Include**:
- **80.01** - Rambursări de credite interne
- **80.02** - Rambursări de credite externe
- **80.03** - Plăți de angajamente din anii anteriori

**Notă**: Spre deosebire de Capitol 30 (dobânzi), aici se rambursează suma împrumutată.

**Exemplu**: Returnarea ratei lunare la un credit pentru construcția unei grădinițe.

---

### Capitol 81 - Plăți din fondul de rezervă

**Definiție simplă**: Utilizarea fondului de rezervă bugetară pentru situații neprevăzute.

**Include**:
- **81.01** - Cheltuieli din fondul de rezervă

**Exemplu**: Utilizarea rezervei pentru reparații urgente după o furtună.

---

## VENITURI (Revenue Codes)

### Capitol 00 - Venituri fiscale

**Definiție simplă**: Venituri din impozite și taxe colectate de la cetățeni și companii.

**Include**:
- **00.01** - Impozit pe profit
- **00.02** - Impozit pe venit
- **00.03** - Impozit pe proprietate (impozit pe clădiri, teren)
- **00.04** - Impozit pe bunuri și servicii (TVA, accize)
- **00.05** - Taxe vamale
- **00.06** - Alte impozite și taxe

**Exemplu**: Impozitul pe clădiri plătit de cetățeni, taxa pe terenuri, impozit pe venit colectat la nivel local.

---

### Capitol 30 - Venituri nefiscale

**Definiție simplă**: Venituri din activități proprii (chirii, vânzări, servicii, amenzi).

**Include**:
- **30.01** - Venituri din proprietate (chirii, redevențe)
- **30.02** - Vânzări de bunuri și servicii
- **30.03** - Amenzi și penalități
- **30.04** - Diverse venituri

**Exemplu**: Chiria pentru închirierea unui spațiu public, amenzi pentru încălcări ale regulamentelor locale.

---

### Capitol 37 - Venituri din capital

**Definiție simplă**: Venituri din vânzarea activelor (terenuri, clădiri, echipamente).

**Include**:
- **37.01** - Vânzări de terenuri și active nemateriale
- **37.02** - Vânzări de imobile (clădiri)

**Exemplu**: Vânzarea unui teren public, valorificarea unor imobile dezafectate.

---

### Capitol 40 - Transferuri voluntare primite

**Definiție simplă**: Donații, sponsorizări, granturi primite fără obligație de rambursare.

**Include**:
- **40.01** - Transferuri de la alte nivele ale administrației
- **40.02** - Donații și sponsorizări

**Exemplu**: Donație de la o companie pentru un proiect social, grant UE pentru infrastructură.

---

### Capitol 41 - Transferuri primite de la bugetul de stat și bugetele locale

**Definiție simplă**: Fonduri primite de la nivelul central sau județean pentru susținerea bugetului local.

**Include**:
- **41.01** - Subvenții de la bugetul de stat
- **41.02** - Cote și sume defalcate din impozitele centrale

**Exemplu**: Transferuri de la bugetul de stat pentru funcționarea învățământului, quote din TVA repartizate local.

---

### Capitol 45 - Împrumuturi

**Definiție simplă**: Fonduri obținute prin contractarea de credite (care trebuie rambursate).

**Include**:
- **45.01** - Împrumuturi interne
- **45.02** - Împrumuturi externe

**Notă**: Împrumuturile cresc datoria publică și trebuie rambursate cu dobândă.

**Exemplu**: Credit bancar contractat pentru finanțarea unui proiect de infrastructură.

---

## Concepte importante

### Cheltuieli curente vs. Cheltuieli de capital

- **Cheltuieli curente** (Capitol 10-59): Costuri repetitive pentru funcționarea curentă (salarii, utilități, întreținere)
- **Cheltuieli de capital** (Capitol 70): Investiții cu efect pe termen lung (clădiri, echipamente)

### Cheltuieli de dezvoltare vs. Cheltuieli de funcționare

În sistemul românesc, cheltuielile se pot clasifica și astfel:
- **Funcționare**: Cheltuieli pentru menținerea activității curente
- **Dezvoltare**: Investiții și proiecte noi care măresc capacitatea instituției

---

## Cum se folosesc codurile economice?

1. **Pentru analiza structurii de cost**: Vezi cât din buget merge pe salarii (10.), cât pe investiții (70.), cât pe utilități (20.01.03).

2. **Pentru eficiență**: Compară entități similare să vezi dacă cheltuielile administrative sunt proporționale.

3. **Pentru sustenabilitate**: Un buget echilibrat ar trebui să aibă cheltuieli de capital (70.) pentru dezvoltare, nu doar cheltuieli curente.

4. **Pentru identificarea dependenței**: Cât din venituri vine din impozite proprii (00.) vs. transferuri (41.)?

---

## Exemple practice

**Exemplu 1**: Cât cheltuiește o primărie pe salarii?
- Cod economic: **10.** (toate subcategoriile de personal)

**Exemplu 2**: Care este valoarea investițiilor în infrastructură?
- Cod economic: **70.01.01** (Construcții)

**Exemplu 3**: Cât se cheltuiește pe energie și utilități?
- Cod economic: **20.01.03** (Încălzit, iluminat, forță motrică)

**Exemplu 4**: Cum se finanțează bugetul - din venituri proprii sau transferuri?
- Venituri proprii: **00.** + **30.**
- Transferuri: **41.**

---

## Note importante

- **Prefixele** (cod cu punct final, ex. "20.") selectează TOATE subcategoriile
- **Codurile exacte** (ex. "20.01.03") selectează DOAR acea categorie specifică
- Codurile economice răspund la **"PE CE?"** se cheltuie banii (vs. coduri funcționale care răspund la **"PENTRU CE?"**)
- Combinarea codurilor funcționale și economice oferă imaginea completă: "Cheltuieli cu salariile (10.) pentru educație (65.)"

---

**Surse**:
- Clasificațiile bugetare - Ministerul Finanțelor: https://mfinante.gov.ro/en/domenii/buget/clasificatiile-bugetare
- Legea 500/2002 privind finanțele publice
`;

export function getEconomicClassificationGuide(): string {
  return ECONOMIC_CLASSIFICATION_GUIDE;
}
