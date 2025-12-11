/**
 * Financial Terms Glossary
 *
 * Accessible glossary of Romanian public finance terms.
 */

export function getFinancialTermsGlossary(): string {
  return `# Glosar Termeni Financiari - Buget Public Român

## Termeni de bază

### Buget
Documentul financiar care prevede veniturile și cheltuielile unei instituții publice pentru un an fiscal.

### Buget de stat
Bugetul administrației centrale (Guvern, ministere, agenții naționale).

### Buget local
Bugetul unei unități administrativ-teritoriale (județ, municipiu, oraș, comună).

### Execuție bugetară
Realizarea efectivă a veniturilor și cheltuielilor prevăzute în buget. Se raportează lunar, trimestrial și anual.

### An fiscal / An bugetar
Perioada de 12 luni pentru care se întocmește bugetul. În România: 1 ianuarie - 31 decembrie.

## Entități și instituții

### CUI (Cod Unic de Identificare)
Codul fiscal unic al unei entități (similar cu CNP-ul pentru persoane fizice). Format: 7-10 cifre.

### UAT (Unitate Administrativ-Teritorială)
Entitate administrativă locală: județ, municipiu, oraș sau comună.

### Municipiu
Oraș mare, reședință de județ sau cu importanță economică deosebită (ex: București, Cluj-Napoca, Timișoara).

### Oraș
Localitate urbană mai mică decât municipiul.

### Comună
Unitate administrativă rurală, formată din unul sau mai multe sate.

### Județ
Unitate administrativă de nivel superior, care cuprinde mai multe municipii, orașe și comune.

### Instituție publică
Organizație finanțată din fonduri publice: primărie, școală, spital, etc.

## Venituri

### Venituri proprii
Venituri colectate direct de instituție (impozite locale, taxe, chirii, etc.).

### Venituri fiscale
Venituri din impozite și taxe obligatorii.

### Venituri nefiscale
Venituri din activitatea proprie: chirii, concesiuni, prestări servicii, amenzi.

### Cote defalcate
Procent din impozitul pe venit colectat la nivel național, redistribuit către bugetele locale.

### Sume defalcate
Sumele efective primite de la bugetul de stat (cote defalcate din impozitul pe venit).

### Transferuri
Sume primite de la alte bugete (de la bugetul de stat către bugetele locale).

### Subvenții
Sume acordate pentru acoperirea unor cheltuieli specifice sau diferențe de preț/tarif.

### Fonduri europene
Finanțări nerambursabile primite de la Uniunea Europeană pentru proiecte.

## Cheltuieli

### Cheltuieli curente / de funcționare
Cheltuieli necesare pentru funcționarea curentă: salarii, utilități, întreținere. Se repetă în fiecare an.

### Cheltuieli de capital / investiții
Cheltuieli pentru achiziții de active pe termen lung: construcții, echipamente, modernizări.

### Cheltuieli de personal
Toate cheltuielile cu angajații: salarii, contribuții sociale, sporuri, prime.

### Bunuri și servicii
Cheltuieli pentru funcționare: utilități, materiale, reparații, servicii.

### Asistență socială
Ajutoare sociale, alocații, burse, indemnizații pentru populație.

### Cheltuieli de dezvoltare
Investiții în infrastructură, proiecte noi, modernizări majore.

### Cheltuieli de functionare
Cheltuieli curente pentru menținerea activității: salarii, utilități, întreținere.

## Clasificări bugetare

### Clasificare funcțională (COFOG)
Clasificare după scopul cheltuielilor: PENTRU CE se cheltuiesc banii (educație, sănătate, transport, etc.).

### Clasificare economică
Clasificare după natura cheltuielilor: CUM se cheltuiesc banii (salarii, bunuri și servicii, investiții, etc.).

### Capitol
Primul nivel al clasificării (2 cifre). Ex: 65 = Învățământ, 10 = Cheltuieli de personal.

### Subcapitol
Al doilea nivel al clasificării (4 cifre). Ex: 65.10 = Învățământ primar, 10.01 = Cheltuieli salariale în bani.

### Paragraf
Al treilea nivel al clasificării (6 cifre). Ex: 65.10.03 = Învățământ primar - ciclul I.

### Prefix
Cod cu punct final care include toate subcategoriile. Ex: "65." = tot învățământul.

### Cod exact
Cod fără punct final, doar acea categorie specifică. Ex: "65.10" = doar învățământ primar.

## Indicatori financiari

### Venituri totale
Suma tuturor veniturilor: fiscale, nefiscale, transferuri, subvenții.

### Cheltuieli totale
Suma tuturor cheltuielilor: curente și de capital.

### Sold bugetar / Excedent / Deficit
Diferența între venituri și cheltuieli:
- **Excedent**: Venituri > Cheltuieli (sold pozitiv)
- **Deficit**: Venituri < Cheltuieli (sold negativ)
- **Echilibru**: Venituri = Cheltuieli

### Execuție bugetară
Procentul din bugetul planificat care a fost efectiv realizat.
- **Execuție venituri**: Venituri realizate / Venituri planificate × 100
- **Execuție cheltuieli**: Cheltuieli realizate / Cheltuieli planificate × 100

### Grad de colectare
Procentul din veniturile planificate care au fost efectiv încasate.

### Grad de realizare
Procentul din cheltuielile planificate care au fost efectiv plătite.

## Normalizare și comparații

### Normalizare
Ajustarea datelor pentru a permite comparații corecte între entități de dimensiuni diferite.

### Per capita (pe cap de locuitor)
Valoare împărțită la numărul de locuitori. Permite comparații între localități de dimensiuni diferite.
- **Formula**: Valoare totală / Populație
- **Exemplu**: 100.000.000 RON / 100.000 locuitori = 1.000 RON/locuitor

### Normalizare la inflație
Ajustarea valorilor pentru a elimina efectul inflației și a permite comparații în timp.

### Normalizare la EUR
Convertirea sumelor din RON în EUR pentru comparații internaționale.

### Valoare reală vs. valoare nominală
- **Valoare nominală**: Suma în bani curenți, fără ajustare pentru inflație
- **Valoare reală**: Suma ajustată pentru inflație, reflectă puterea de cumpărare

## Perioade și raportare

### An bugetar
Perioada 1 ianuarie - 31 decembrie pentru care se întocmește și execută bugetul.

### Trimestru
Perioadă de 3 luni:
- T1: ianuarie-martie
- T2: aprilie-iunie
- T3: iulie-septembrie
- T4: octombrie-decembrie

### Semestru
Perioadă de 6 luni:
- S1: ianuarie-iunie
- S2: iulie-decembrie

### Raportare lunară
Raportul de execuție bugetară întocmit lunar.

### Raportare anuală
Raportul final de execuție bugetară pentru întregul an.

## Tipuri de rapoarte

### Raport de execuție bugetară
Document care prezintă veniturile și cheltuielile realizate într-o perioadă.

### Cont de execuție
Raportul final anual care prezintă execuția bugetară pentru întregul an.

### Balanță de verificare
Document contabil care prezintă soldurile conturilor la o anumână dată.

## Termeni specifici României

### RON (Leu românesc)
Moneda națională a României. 1 RON = 100 bani.

### TVA (Taxa pe Valoarea Adăugată)
Impozit indirect pe consum. Cote: 19% (standard), 9% (redusă), 5% (super-redusă).

### CAS (Contribuția la Asigurările Sociale)
Contribuție pentru pensii. Cotă: 25% (angajat).

### CASS (Contribuția la Asigurările Sociale de Sănătate)
Contribuție pentru asigurări de sănătate. Cotă: 10% (angajat).

### Impozit pe venit
Impozit pe veniturile persoanelor fizice. Cotă: 10% (flat tax).

### Impozit pe profit
Impozit pe profitul companiilor. Cotă: 16%.

### Impozit pe clădiri
Impozit local pe proprietățile imobiliare (clădiri).

### Impozit pe teren
Impozit local pe terenuri.

### Taxa de salubrizare
Taxă locală pentru serviciile de colectare și transport deșeuri.

## Termeni legali

### Legea finanțelor publice locale (nr. 273/2006)
Legea cadru care reglementează finanțele publice locale în România.

### Legea bugetului de stat
Legea anuală care aprobă bugetul de stat pentru anul respectiv.

### Ordonanță de urgență (OUG)
Act normativ emis de Guvern în situații excepționale.

### Hotărâre de Guvern (HG)
Act normativ emis de Guvern pentru aplicarea legilor.

### Hotărâre a Consiliului Local (HCL)
Decizie adoptată de consiliul local al unei UAT.

## Abrevieri comune

- **UAT**: Unitate Administrativ-Teritorială
- **CUI**: Cod Unic de Identificare
- **RON**: Leu românesc
- **EUR**: Euro
- **TVA**: Taxa pe Valoarea Adăugată
- **CAS**: Contribuția la Asigurările Sociale
- **CASS**: Contribuția la Asigurările Sociale de Sănătate
- **MFP**: Ministerul Finanțelor Publice
- **ANAF**: Agenția Națională de Administrare Fiscală
- **INS**: Institutul Național de Statistică
- **PIB**: Produsul Intern Brut
- **COFOG**: Classification of Functions of Government

## Resurse suplimentare

Pentru mai multe informații despre termenii financiari:
- Legea finanțelor publice locale nr. 273/2006
- Ghidul utilizatorului Transparenta.eu
- Glosarul Ministerului Finanțelor Publice
`;
}
