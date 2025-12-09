/**
 * Economic Classification Guide
 *
 * Romanian public budget economic classification guide.
 */

export function getEconomicClassificationGuide(): string {
  return `# Ghid Clasificare Economică - Bugetul Public Român

## Introducere

Clasificarea economică a bugetului public român răspunde la întrebarea: **"CUM se cheltuiesc banii publici?"**

Clasificarea economică organizează cheltuielile și veniturile după natura lor economică, indiferent de scopul pentru care sunt destinate.

## Structura Ierarhică

Clasificarea economică are 3 niveluri:
1. **Capitol** (2 cifre): Categoria principală (ex: 10 = Cheltuieli de personal)
2. **Subcapitol** (4 cifre): Subdiviziunea categoriei (ex: 10.01 = Cheltuieli salariale în bani)
3. **Paragraf** (6 cifre): Detaliul specific (ex: 10.01.01 = Salarii de bază)

## CHELTUIELI (Capitole 10-85)

### 10 - Cheltuieli de personal
Toate cheltuielile cu personalul: salarii, contribuții sociale, alte drepturi.

**Subcapitole importante:**
- 10.01 - Cheltuieli salariale în bani
  - 10.01.01 - Salarii de bază
  - 10.01.02 - Sporuri pentru condiții de muncă
  - 10.01.03 - Ore suplimentare
  - 10.01.05 - Indemnizații de delegare/detașare
  - 10.01.06 - Fond de premiere
  - 10.01.30 - Alte drepturi salariale în bani
- 10.02 - Cheltuieli salariale în natură
- 10.03 - Contribuții (CAS, CASS, șomaj, etc.)

**Note:**
- Cel mai mare capitol de cheltuieli pentru majoritatea instituțiilor
- Include și contribuțiile sociale plătite de angajator
- Aproximativ 40-60% din bugetul unei instituții publice

### 20 - Bunuri și servicii
Cheltuieli curente pentru funcționarea instituțiilor: utilități, materiale, servicii.

**Subcapitole importante:**
- 20.01 - Bunuri și servicii
  - 20.01.01 - Furnituri de birou
  - 20.01.02 - Materiale pentru curățenie
  - 20.01.03 - Încălzit, iluminat, forță motrică
  - 20.01.04 - Apă, canal, salubritate
  - 20.01.05 - Carburanți și lubrifianți
  - 20.01.06 - Piese de schimb
  - 20.01.08 - Poștă, telecomunicații, radio, tv, internet
  - 20.01.09 - Materiale și prestări de servicii cu caracter funcțional
  - 20.01.30 - Alte bunuri și servicii pentru întreținere și funcționare
- 20.02 - Reparații curente
- 20.03 - Hrana
- 20.04 - Medicamente și materiale sanitare
- 20.05 - Bunuri de natura obiectelor de inventar
- 20.06 - Deplasări, detașări, transferări
- 20.09 - Materiale de laborator
- 20.13 - Pregătire profesională
- 20.14 - Protecția muncii

**Note:**
- Al doilea capitol ca mărime după cheltuielile de personal
- Include toate cheltuielile curente de funcționare
- Aproximativ 20-30% din bugetul unei instituții

### 30 - Dobânzi
Dobânzi aferente datoriei publice și împrumuturilor.

**Subcapitole:**
- 30.01 - Dobânzi aferente datoriei publice interne
- 30.02 - Dobânzi aferente datoriei publice externe

### 40 - Subvenții
Subvenții acordate companiilor publice și private.

**Subcapitole:**
- 40.01 - Subvenții pentru acoperirea diferențelor de preț și tarif
- 40.02 - Subvenții pentru producători
- 40.03 - Subvenții pentru instituții publice
- 40.04 - Subvenții pentru instituții private

### 50 - Fonduri de rezervă
Rezerve bugetare pentru situații neprevăzute.

### 51 - Transferuri între unități ale administrației publice
Transferuri între bugete (de la buget de stat la bugete locale, etc.).

**Note:**
- Adesea excluse din analize pentru a evita dubla contabilizare
- Reprezintă mișcări de bani între instituții publice

### 55 - Alte transferuri
Transferuri către alte entități: ONG-uri, persoane fizice, etc.

**Subcapitole:**
- 55.01 - Transferuri curente către alte entități
- 55.02 - Transferuri de capital către alte entități

### 57 - Asistență socială
Ajutoare sociale, alocații, indemnizații pentru populație.

**Subcapitole importante:**
- 57.01 - Ajutoare sociale în numerar
- 57.02 - Ajutoare sociale în natură
- 57.03 - Burse
- 57.04 - Alocații
- 57.05 - Indemnizații

**Note:**
- Important pentru primării (ajutoare sociale locale)
- Include ajutoare pentru încălzit, ajutoare de urgență

### 59 - Alte cheltuieli
Alte cheltuieli care nu se încadrează în categoriile anterioare.

**Subcapitole:**
- 59.01 - Despăgubiri civile
- 59.02 - Contribuții și cotizații
- 59.15 - Sume aferente persoanelor cu handicap neîncadrate
- 59.22 - Contribuția României la bugetul UE

### 70 - Cheltuieli de capital (Investiții)
Investiții în active fixe: clădiri, echipamente, infrastructură.

**Subcapitole importante:**
- 70.01 - Active fixe (construcții, echipamente)
  - 70.01.01 - Construcții
  - 70.01.02 - Mașini, echipamente și mijloace de transport
  - 70.01.03 - Mobilier, aparatură birotică și alte active corporale
  - 70.01.30 - Alte active fixe
- 70.02 - Stocuri
- 70.03 - Reparații capitale aferente activelor fixe

**Note:**
- Investiții pe termen lung
- Construcții noi, modernizări, echipamente
- Variază mult de la an la an

### 79 - Plăți efectuate în anii precedenți și recuperate în anul curent
Regularizări și recuperări.

### 80 - Rambursări de credite
Rambursarea împrumuturilor contractate.

**Subcapitole:**
- 80.01 - Rambursări de credite interne
- 80.02 - Rambursări de credite externe

### 81 - Plăți de dobânzi la datoria publică
Similar cu capitolul 30, dar pentru plăți efective.

### 84 - Rezerve
Rezerve bugetare.

### 85 - Operațiuni financiare
Operațiuni financiare diverse.

## VENITURI (Capitole 00-48)

### 00 - Venituri fiscale
Impozite și taxe.

**Subcapitole importante:**
- 00.01 - Impozit pe venit, profit și câștiguri din capital
  - 00.01.01 - Impozit pe profit
  - 00.01.02 - Impozit pe veniturile microîntreprinderilor
  - 00.01.03 - Impozit pe venitul din salarii
  - 00.01.04 - Impozit pe venitul din activități independente
  - 00.01.05 - Impozit pe venitul din cedarea folosinței bunurilor
  - 00.01.06 - Impozit pe venitul din investiții
  - 00.01.07 - Impozit pe venitul din pensii
  - 00.01.08 - Impozit pe venitul din activități agricole
  - 00.01.30 - Alte impozite pe venit
- 00.02 - Impozite pe proprietate
  - 00.02.01 - Impozit pe clădiri
  - 00.02.02 - Impozit pe teren
  - 00.02.03 - Taxe judiciare de timbru
  - 00.02.05 - Impozit pe mijloacele de transport
  - 00.02.07 - Taxe asupra serviciilor specifice
- 00.03 - Impozite și taxe pe bunuri și servicii
  - 00.03.01 - Taxa pe valoarea adăugată (TVA)
  - 00.03.02 - Accize
  - 00.03.03 - Taxe pe servicii specifice
  - 00.03.04 - Taxe pe utilizarea bunurilor, autorizarea utilizării bunurilor sau pe desfășurarea de activități

**Note:**
- Principala sursă de venituri pentru bugetele locale
- Impozitele pe proprietate (clădiri, teren) sunt colectate de primării

### 30 - Venituri nefiscale
Venituri din activitatea proprie, chirii, concesiuni, dividende.

**Subcapitole importante:**
- 30.01 - Venituri din proprietate
  - 30.01.01 - Venituri din concesiuni și închirieri
  - 30.01.02 - Redevențe
  - 30.01.03 - Dividende
  - 30.01.04 - Venituri din dobânzi
- 30.02 - Vânzări de bunuri și servicii
  - 30.02.01 - Venituri din prestări de servicii și alte activități
  - 30.02.03 - Taxe administrative, eliberări permise
  - 30.02.05 - Amenzi, penalități și confiscări
  - 30.02.08 - Diverse venituri
- 30.03 - Taxe administrative și alte venituri

### 33 - Venituri din capital
Venituri din vânzarea de active.

**Subcapitole:**
- 33.10 - Venituri din valorificarea unor bunuri
  - 33.10.01 - Venituri din vânzarea unor bunuri
  - 33.10.02 - Venituri din valorificarea unor bunuri confiscate

### 37 - Transferuri voluntare, altele decât subvențiile
Donații, sponsorizări.

### 39 - Alte venituri
Alte venituri care nu se încadrează în categoriile anterioare.

### 40 - Subvenții
Subvenții primite de la alte bugete.

### 42 - Transferuri între unități ale administrației publice
Transferuri primite de la alte bugete publice.

**Subcapitole:**
- 42.01 - Transferuri curente
- 42.02 - Transferuri de capital

**Note:**
- Important pentru bugetele locale (sume de la bugetul de stat)
- Include cote defalcate din impozitul pe venit

### 43 - Operațiuni financiare
Împrumuturi, credite primite.

### 45 - Sume primite de la UE
Fonduri europene.

### 48 - Alte venituri
Alte venituri diverse.

## Tipuri de cheltuieli

### Cheltuieli curente (de funcționare)
- Capitol 10 - Cheltuieli de personal
- Capitol 20 - Bunuri și servicii
- Capitol 30 - Dobânzi
- Capitol 50 - Transferuri curente
- Capitol 57 - Asistență socială

**Caracteristici:**
- Se repetă în fiecare an
- Necesare pentru funcționarea curentă
- Aproximativ 70-80% din bugetul total

### Cheltuieli de capital (investiții)
- Capitol 70 - Cheltuieli de capital
- Capitol 71 - Active nefinanciare

**Caracteristici:**
- Investiții pe termen lung
- Variază de la an la an
- Aproximativ 10-20% din bugetul total
- Includ construcții, echipamente, modernizări

### Cheltuieli de dezvoltare vs. funcționare

**Dezvoltare:**
- Investiții în infrastructură
- Proiecte noi
- Modernizări majore
- Capitol 70 (Cheltuieli de capital)

**Funcționare:**
- Cheltuieli curente
- Salarii, utilități, întreținere
- Capitole 10, 20, 57

## Cum se folosește clasificarea economică?

### Pentru analiză bugetară:
1. **Structura cheltuielilor**: Vezi cât se duce pe salarii vs. investiții
2. **Eficiență**: Compară cheltuielile de funcționare între instituții similare
3. **Investiții**: Urmărește evoluția investițiilor în timp

### Exemple de utilizare:

**Exemplu 1: Cheltuieli de personal în Cluj-Napoca**
- Capitol: 10 (Cheltuieli de personal)
- Include toate subcapitolele: 10.01, 10.02, 10.03
- Folosește prefix: "10." pentru a include toate subcategoriile

**Exemplu 2: Doar salarii de bază**
- Paragraf: 10.01.01 (Salarii de bază)
- Mai specific decât capitolul întreg

**Exemplu 3: Investiții în infrastructură**
- Capitol: 70 (Cheltuieli de capital)
- Subcapitol: 70.01.01 (Construcții)

## Combinarea clasificărilor

Clasificarea economică se combină cu clasificarea funcțională pentru analize complete:

**Exemplu: Salarii profesori**
- Funcțional: 65.10 (Învățământ primar)
- Economic: 10.01.01 (Salarii de bază)
- Rezultat: Salarii de bază pentru profesorii de învățământ primar

## Prefixe vs. Coduri Exacte

### Prefixe (cu punct final: "10.")
- Includ toate subcategoriile
- Exemplu: "10." = toate cheltuielile de personal
- Folosit pentru analiză la nivel de capitol

### Coduri exacte (fără punct final: "10.01")
- Doar acea categorie specifică
- Exemplu: "10.01" = doar cheltuieli salariale în bani
- Folosit pentru analiză detaliată

## Note importante

1. **Clasificarea economică este obligatorie** pentru toate instituțiile publice
2. **Se combină cu clasificarea funcțională** pentru analize complete
3. **Codurile se normalizează** - "10.00.00" devine "10"
4. **Transferurile (51, 42) sunt adesea excluse** din analize pentru a evita dubla contabilizare

## Resurse suplimentare

Pentru detalii complete despre clasificarea economică, consultați:
- Ordinul MFP privind clasificația bugetară
- Legea finanțelor publice locale nr. 273/2006
- Ghidul utilizatorului Transparenta.eu
`;
}
