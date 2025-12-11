/**
 * Functional Classification Guide (COFOG-based)
 *
 * Romanian public budget functional classification guide based on COFOG
 * (Classification of Functions of Government).
 */

export function getFunctionalClassificationGuide(): string {
  return `# Ghid Clasificare Funcțională - Bugetul Public Român

## Introducere

Clasificarea funcțională a bugetului public român este bazată pe standardul internațional COFOG (Classification of Functions of Government) și răspunde la întrebarea: **"PENTRU CE se cheltuiesc banii publici?"**

Clasificarea funcțională organizează cheltuielile după scopul sau funcția pentru care sunt destinate, indiferent de instituția care le execută.

## Structura Ierarhică

Clasificarea funcțională are 3 niveluri:
1. **Capitol** (2 cifre): Funcția principală (ex: 65 = Învățământ)
2. **Subcapitol** (4 cifre): Subdiviziunea funcției (ex: 65.10 = Învățământ primar)
3. **Paragraf** (6 cifre): Detaliul specific (ex: 65.10.03 = Învățământ primar - ciclul I)

## Capitole Principale (Funcții)

### 51 - Autorități publice și acțiuni externe
Funcționarea instituțiilor statului, relații externe, diplomație.

**Subcapitole importante:**
- 51.01 - Autorități publice
- 51.02 - Acțiuni externe
- 51.03 - Alte servicii publice generale

### 54 - Tranzacții privind datoria publică și împrumuturi
Serviciul datoriei publice, dobânzi, rambursări.

**Subcapitole:**
- 54.02 - Dobânzi aferente datoriei publice
- 54.03 - Alte cheltuieli în legătură cu datoria publică

### 61 - Ordine publică și siguranță națională
Poliție, jandarmi, pompieri, protecție civilă, justiție.

**Subcapitole importante:**
- 61.01 - Poliție
- 61.02 - Protecție civilă și protecție contra incendiilor
- 61.03 - Instanțe judecătorești
- 61.04 - Penitenciare

### 65 - Învățământ
Educație la toate nivelurile, de la preșcolar la universitar.

**Subcapitole importante:**
- 65.02 - Învățământ preșcolar și primar
- 65.10 - Învățământ primar
- 65.20 - Învățământ secundar
- 65.30 - Învățământ superior
- 65.40 - Învățământ postuniversitar
- 65.50 - Învățământ profesional și tehnic
- 65.60 - Alte forme de învățământ

**Note:**
- Cel mai mare capitol din bugetele locale
- Include salarii profesori, utilități școli, rechizite, burse
- Învățământul preuniversitar este finanțat de la bugetele locale

### 66 - Sănătate
Servicii medicale, spitale, centre de sănătate, programe de sănătate publică.

**Subcapitole importante:**
- 66.01 - Spitale
- 66.02 - Unități medico-sociale și alte unități speciale de sănătate
- 66.03 - Policlinici și dispensare
- 66.04 - Centre de sănătate
- 66.05 - Medicina muncii
- 66.06 - Alte cheltuieli în domeniul sănătății

**Note:**
- Spitalele mari sunt finanțate de la buget de stat
- Primăriile finanțează centre de sănătate, dispensare, ambulanțe

### 67 - Cultură, recreere și religie
Cultură, sport, biblioteci, muzee, teatre, culte religioase.

**Subcapitole importante:**
- 67.01 - Activități sportive și recreative
- 67.02 - Activități culturale
- 67.03 - Activități de difuzare a culturii prin mijloace de informare în masă
- 67.04 - Culte religioase

### 68 - Asigurări și asistență socială
Protecție socială, ajutoare sociale, pensii, indemnizații.

**Subcapitole importante:**
- 68.01 - Asigurări și asistență socială în caz de boală și invaliditate
- 68.02 - Asigurări și asistență socială pentru familie și copii
- 68.03 - Asigurări și asistență socială în caz de șomaj
- 68.04 - Ajutoare pentru locuințe
- 68.05 - Alte cheltuieli în domeniul asigurărilor și asistenței sociale

**Note:**
- Include ajutoare sociale, cantinele sociale, centre de zi
- Primăriile gestionează ajutoarele sociale locale

### 70 - Locuințe, servicii și dezvoltare publică
Locuințe sociale, apă, canalizare, salubritate, iluminat public.

**Subcapitole importante:**
- 70.01 - Locuințe
- 70.02 - Dezvoltare publică
- 70.03 - Alimentare cu apă
- 70.04 - Iluminat public și electrificări
- 70.05 - Alimentare cu gaze naturale în localități
- 70.06 - Salubritate
- 70.07 - Canalizare și tratarea apelor uzate

**Note:**
- Capitol major pentru primării
- Include salubrizare, apă-canal, iluminat stradal
- Investiții în infrastructură urbană

### 74 - Protecția mediului
Protecția mediului, gestionarea deșeurilor, combaterea poluării.

**Subcapitole:**
- 74.01 - Administrație generală în domeniul protecției mediului
- 74.02 - Administrarea deșeurilor
- 74.03 - Reducerea poluării
- 74.04 - Protecția biodiversității și a peisajului

### 81 - Combustibili și energie
Energie, combustibili, resurse energetice.

### 83 - Agricultura, silvicultura, piscicultura și vânătoarea
Agricultură, dezvoltare rurală, silvicultură.

**Subcapitole:**
- 83.01 - Agricultura
- 83.02 - Silvicultura
- 83.03 - Piscicultura și vânătoarea

### 84 - Transporturi
Drumuri, transport public, infrastructură de transport.

**Subcapitole importante:**
- 84.01 - Transport rutier
- 84.02 - Transport feroviar
- 84.03 - Transport aerian
- 84.04 - Transport naval
- 84.05 - Alte cheltuieli în domeniul transporturilor

**Note:**
- Include întreținere drumuri, transport public local
- Investiții în infrastructură rutieră

### 85 - Alte acțiuni economice
Comerț, turism, dezvoltare economică, alte servicii economice.

**Subcapitole:**
- 85.01 - Comerț
- 85.02 - Turism
- 85.03 - Alte acțiuni economice

## Cum se folosește clasificarea funcțională?

### Pentru analiză bugetară:
1. **Identificare priorități**: Vezi unde se duc cei mai mulți bani
2. **Comparații**: Compară cheltuielile pentru educație între orașe
3. **Tendințe**: Urmărește evoluția cheltuielilor pe funcții în timp

### Exemple de utilizare:

**Exemplu 1: Cheltuieli pentru educație în Cluj-Napoca**
- Capitol: 65 (Învățământ)
- Include toate subcapitolele: 65.02, 65.10, 65.20, etc.
- Folosește prefix: "65." pentru a include toate subcategoriile

**Exemplu 2: Doar învățământul primar**
- Subcapitol: 65.10 (Învățământ primar)
- Mai specific decât capitolul întreg

**Exemplu 3: Salubritate în București**
- Subcapitol: 70.06 (Salubritate)
- Include gunoi menajer, curățenie stradală

## Prefixe vs. Coduri Exacte

### Prefixe (cu punct final: "65.")
- Includ toate subcategoriile
- Exemplu: "65." = tot învățământul (65.02, 65.10, 65.20, etc.)
- Folosit pentru analiză la nivel de capitol

### Coduri exacte (fără punct final: "65.10")
- Doar acea categorie specifică
- Exemplu: "65.10" = doar învățământ primar
- Folosit pentru analiză detaliată

## Note importante

1. **Clasificarea funcțională este obligatorie** pentru toate instituțiile publice
2. **Aceeași funcție poate fi executată de instituții diferite** (ex: învățământ de la primărie și de la județ)
3. **Clasificarea funcțională se combină cu clasificarea economică** pentru a vedea ȘI ce se face ȘI cum se cheltuiesc banii
4. **Codurile se normalizează** - "65.00.00" devine "65"

## Resurse suplimentare

Pentru detalii complete despre clasificarea funcțională, consultați:
- Ordinul MFP privind clasificația bugetară
- Legea finanțelor publice locale nr. 273/2006
- Ghidul utilizatorului Transparenta.eu
`;
}
