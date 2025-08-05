import { z } from "zod";

export const datasetsData = [
  {
    "id": "gdp-romania",
    "name": "PIB-ul României",
    "description": "Produsul Intern Brut, care indică dimensiunea economiei și baza pentru veniturile fiscale publice, influențând alocările bugetare.",
    "sourceName": "Institutul Național de Statistică",
    "sourceUrl": "https://insse.ro/cms/ro/tags/comunicat-pib-anual",
    "unit": "RON",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 765100000000 },
      { "year": 2017, "totalAmount": 857900000000 },
      { "year": 2018, "totalAmount": 1011700000000 },
      { "year": 2019, "totalAmount": 1047740000000 },
      { "year": 2020, "totalAmount": 1066000000000 },
      { "year": 2021, "totalAmount": 1264065000000 },
      { "year": 2022, "totalAmount": 1403693000000 },
      { "year": 2023, "totalAmount": 1604554000000 },
      { "year": 2024, "totalAmount": 1766067000000 }
    ]
  },
  {
    "id": "inflation-rate-romania",
    "name": "Rata inflației României",
    "description": "Creșterea generală a prețurilor care afectează puterea de cumpărare și capacitatea de finanțare a cheltuielilor publice.",
    "sourceName": "Banca Națională a României",
    "sourceUrl": "https://www.bnr.ro/uploads/2025-2raportasuprainfla%E8%9Bieifebruarie2025_documentpdf_545_1739785417.pdf",
    "unit": "%",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": -1.5 },
      { "year": 2017, "totalAmount": 1.3 },
      { "year": 2018, "totalAmount": 4.6 },
      { "year": 2019, "totalAmount": 3.8 },
      { "year": 2020, "totalAmount": 2.6 },
      { "year": 2021, "totalAmount": 5.1 },
      { "year": 2022, "totalAmount": 13.8 },
      { "year": 2023, "totalAmount": 10.4 },
      { "year": 2024, "totalAmount": 5.6 }
    ]
  },
  {
    "id": "population-romania",
    "name": "Populația României",
    "description": "Numărul de locuitori care determină baza de contribuabili și beneficiarii serviciilor publice, influențând structura bugetară.",
    "sourceName": "Institutul Național de Statistică",
    "sourceUrl": "https://insse.ro/cms/ro/content/popula%C5%A3ia-dup%C4%83-domiciliu-la-1-ianuarie-2024",
    "unit": "persoane",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 21900000 },
      { "year": 2017, "totalAmount": 21850000 },
      { "year": 2018, "totalAmount": 21800000 },
      { "year": 2019, "totalAmount": 21750000 },
      { "year": 2020, "totalAmount": 21700000 },
      { "year": 2021, "totalAmount": 21650000 },
      { "year": 2022, "totalAmount": 21600000 },
      { "year": 2023, "totalAmount": 21054400 },
      { "year": 2024, "totalAmount": 19064409 }
    ]
  },
  {
    "id": "public-debt-romania",
    "name": "Datoria publică România",
    "description": "Datoria guvernamentală ca procent din PIB, indicator esențial pentru sustenabilitatea fiscală și capacitatea de împrumut viitoare.",
    "sourceName": "Ministerul Finanțelor",
    "sourceUrl": "https://mfinante.gov.ro/static/10/Mfp/transparenta/proiectbuget2025/raportproiectLegeBuget2025_30012025.pdf",
    "unit": "% din PIB",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 37.3 },
      { "year": 2017, "totalAmount": 35.2 },
      { "year": 2018, "totalAmount": 35.0 },
      { "year": 2019, "totalAmount": 35.0 },
      { "year": 2020, "totalAmount": 46.6 },
      { "year": 2021, "totalAmount": 48.8 },
      { "year": 2022, "totalAmount": 47.3 },
      { "year": 2023, "totalAmount": 48.9 },
      { "year": 2024, "totalAmount": 54.6 }
    ]
  },
  {
    "id": "interest-rate-romania",
    "name": "Rata dobânzii BNR",
    "description": "Rata dobânzii de politică monetară care influențează costul finanțării publice și private, impactând cheltuielile bugetare cu dobânzile.",
    "sourceName": "Banca Națională a României",
    "sourceUrl": "https://www.bnro.ro/page.aspx?prid=25940",
    "unit": "% pe an",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 1.75 },
      { "year": 2017, "totalAmount": 1.75 },
      { "year": 2018, "totalAmount": 2.50 },
      { "year": 2019, "totalAmount": 2.50 },
      { "year": 2020, "totalAmount": 1.25 },
      { "year": 2021, "totalAmount": 1.25 },
      { "year": 2022, "totalAmount": 7.00 },
      { "year": 2023, "totalAmount": 7.00 },
      { "year": 2024, "totalAmount": 6.50 }
    ]
  },
  {
    "id": "unemployment-rate-romania",
    "name": "Rata șomajului România",
    "description": "Procentul populației active fără loc de muncă, care afectează veniturile din contribuții sociale și necesarul pentru ajutorul de șomaj.",
    "sourceName": "Agenția Națională pentru Ocuparea Forței de Muncă",
    "sourceUrl": "https://www.anofm.ro/wp-content/uploads/2025/05/Raport-de-activitate-al-ANOFM-pentru-anul-2024.pdf",
    "unit": "%",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 6.2 },
      { "year": 2017, "totalAmount": 5.0 },
      { "year": 2018, "totalAmount": 4.2 },
      { "year": 2019, "totalAmount": 3.9 },
      { "year": 2020, "totalAmount": 5.2 },
      { "year": 2021, "totalAmount": 5.6 },
      { "year": 2022, "totalAmount": 5.8 },
      { "year": 2023, "totalAmount": 2.89 },
      { "year": 2024, "totalAmount": 3.14 }
    ]
  },
  {
    "id": "government-expenditure-romania",
    "name": "Cheltuieli guvernamentale România",
    "description": "Totalul cheltuielilor publice care reflectă magnitudinea intervenției statului în economie și presiunea asupra resurselor bugetare.",
    "sourceName": "Ministerul Finanțelor",
    "sourceUrl": "https://mfinante.gov.ro/static/10/Mfp/buletin/executii/nota_bgc31122024.pdf",
    "unit": "RON",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 270000000000 },
      { "year": 2017, "totalAmount": 290000000000 },
      { "year": 2018, "totalAmount": 320000000000 },
      { "year": 2019, "totalAmount": 360000000000 },
      { "year": 2020, "totalAmount": 420000000000 },
      { "year": 2021, "totalAmount": 470000000000 },
      { "year": 2022, "totalAmount": 550000000000 },
      { "year": 2023, "totalAmount": 610000000000 },
      { "year": 2024, "totalAmount": 727320000000 }
    ]
  },
  {
    "id": "government-revenue-romania",
    "name": "Venituri guvernamentale România",
    "description": "Totalul veniturilor bugetare care determină capacitatea de finanțare a serviciilor publice și investițiilor de stat.",
    "sourceName": "Ministerul Finanțelor",
    "sourceUrl": "https://mfinante.gov.ro/static/10/Mfp/buletin/executii/nota_bgc31122024.pdf",
    "unit": "RON",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 250000000000 },
      { "year": 2017, "totalAmount": 275000000000 },
      { "year": 2018, "totalAmount": 310000000000 },
      { "year": 2019, "totalAmount": 340000000000 },
      { "year": 2020, "totalAmount": 360000000000 },
      { "year": 2021, "totalAmount": 410000000000 },
      { "year": 2022, "totalAmount": 470000000000 },
      { "year": 2023, "totalAmount": 520595800000 },
      { "year": 2024, "totalAmount": 574598800000 }
    ]
  },
  {
    "id": "budget-deficit-romania",
    "name": "Deficit bugetar România",
    "description": "Diferența negativă între venituri și cheltuieli ca procent din PIB, indicator crucial pentru echilibrul fiscal și sustenabilitatea bugetară.",
    "sourceName": "Ministerul Finanțelor",
    "sourceUrl": "https://cursdeguvernare.ro/romania-deficit-buget-corectie-criza-2024-datorie-pib.html",
    "unit": "% din PIB",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": -2.6 },
      { "year": 2017, "totalAmount": -2.9 },
      { "year": 2018, "totalAmount": -2.9 },
      { "year": 2019, "totalAmount": -4.3 },
      { "year": 2020, "totalAmount": -9.2 },
      { "year": 2021, "totalAmount": -7.1 },
      { "year": 2022, "totalAmount": -6.2 },
      { "year": 2023, "totalAmount": -5.61 },
      { "year": 2024, "totalAmount": -8.65 }
    ]
  },
  {
    "id": "gdp-per-capita-romania",
    "name": "PIB pe cap de locuitor România",
    "description": "PIB-ul împărțit la numărul de locuitori, indicator al nivelului de trai și al capacității contributive a cetățenilor pentru bugetul public.",
    "sourceName": "Institutul Național de Statistică",
    "sourceUrl": "https://ziare.com/pib-romania/pib-cap-de-locuitor-a-crescut-nesemnificativ-in-2024-in-romania-1932069",
    "unit": "RON",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 34932 },
      { "year": 2017, "totalAmount": 39267 },
      { "year": 2018, "totalAmount": 46422 },
      { "year": 2019, "totalAmount": 48159 },
      { "year": 2020, "totalAmount": 49125 },
      { "year": 2021, "totalAmount": 58405 },
      { "year": 2022, "totalAmount": 65012 },
      { "year": 2023, "totalAmount": 76224 },
      { "year": 2024, "totalAmount": 92640 }
    ]
  },
  {
    "id": "exchange-rate-eur-ron",
    "name": "Curs de schimb EUR/RON",
    "description": "Cursul mediu anual euro-leu care afectează costul importurilor, al datoriei externe și al proiectelor finanțate din fonduri europene.",
    "sourceName": "Banca Națională a României",
    "sourceUrl": "https://www.curs-valutar-bnr.ro/curs-valutar-mediu-lunar-2024",
    "unit": "RON/EUR",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 4.4908 },
      { "year": 2017, "totalAmount": 4.5681 },
      { "year": 2018, "totalAmount": 4.6540 },
      { "year": 2019, "totalAmount": 4.7452 },
      { "year": 2020, "totalAmount": 4.8371 },
      { "year": 2021, "totalAmount": 4.9215 },
      { "year": 2022, "totalAmount": 4.9465 },
      { "year": 2023, "totalAmount": 4.9465 },
      { "year": 2024, "totalAmount": 4.9746 }
    ]
  },
  {
    "id": "trade-balance-romania",
    "name": "Balanța comercială România",
    "description": "Diferența între exporturi și importuri care afectează balanța de plăți, cursul de schimb și necesarul de finanțare externă.",
    "sourceName": "Institutul Național de Statistică",
    "sourceUrl": "https://agerpres.ro/economic/2025/02/10/ins-deficitul-balantei-comerciale-in-2024-a-crescut-cu-15-3-la-aproape-33-4-miliarde-euro--1420905",
    "unit": "milioane EUR",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": -8500 },
      { "year": 2017, "totalAmount": -10200 },
      { "year": 2018, "totalAmount": -12800 },
      { "year": 2019, "totalAmount": -15200 },
      { "year": 2020, "totalAmount": -12800 },
      { "year": 2021, "totalAmount": -18500 },
      { "year": 2022, "totalAmount": -24800 },
      { "year": 2023, "totalAmount": -28993 },
      { "year": 2024, "totalAmount": -33393 }
    ]
  },
  {
    "id": "foreign-direct-investment-romania",
    "name": "Investiții străine directe România",
    "description": "Fluxul de capital străin care contribuie la dezvoltarea economică, crearea de locuri de muncă și modernizarea infrastructurii.",
    "sourceName": "Banca Națională a României",
    "sourceUrl": "https://www.profit.ro/legal/investitiile-straine-directe-in-romania-realitati-provocari-si-perspective-in-context-european-22078538",
    "unit": "milioane EUR",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 4900 },
      { "year": 2017, "totalAmount": 5500 },
      { "year": 2018, "totalAmount": 6200 },
      { "year": 2019, "totalAmount": 5800 },
      { "year": 2020, "totalAmount": 3010 },
      { "year": 2021, "totalAmount": 7400 },
      { "year": 2022, "totalAmount": 10587 },
      { "year": 2023, "totalAmount": 6748 },
      { "year": 2024, "totalAmount": 5730 }
    ]
  },
  {
    "id": "poverty-risk-romania",
    "name": "Rata sărăciei România",
    "description": "Procentul populației în risc de sărăcie sau excluziune socială, indicator al eficacității politicilor sociale și al necesarului pentru asistență publică.",
    "sourceName": "Institutul Național de Statistică / Eurostat",
    "sourceUrl": "https://insse.ro/cms/sites/default/files/com_presa/com_pdf/saracia_si_excluziunea_sociala_r2024.pdf",
    "unit": "% populație",
    "yearlyTrend": [
      { "year": 2016, "totalAmount": 25.3 },
      { "year": 2017, "totalAmount": 23.6 },
      { "year": 2018, "totalAmount": 23.5 },
      { "year": 2019, "totalAmount": 23.8 },
      { "year": 2020, "totalAmount": 26.8 },
      { "year": 2021, "totalAmount": 27.4 },
      { "year": 2022, "totalAmount": 28.4 },
      { "year": 2023, "totalAmount": 29.1 },
      { "year": 2024, "totalAmount": 27.9 }
    ]
  }
];

function validateDatasets() {
  // Use zod to validate the datasets data and make sure the ids are unique
  const datasetSchema = z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    sourceName: z.string(),
    sourceUrl: z.string(),
    unit: z.string(),
    yearlyTrend: z.array(z.object({
      year: z.number(),
      totalAmount: z.number(),
    })),
  }));

  const result = datasetSchema.safeParse(datasetsData);
  if (!result.success) {
    console.error(result.error);
    throw new Error("Invalid datasets data");
  }

  // Make sure the ids are unique
  const idSet = new Set(datasetsData.map(dataset => dataset.id));
  if (idSet.size !== datasetsData.length) {
    console.error(Array.from(idSet).filter(id => datasetsData.filter(dataset => dataset.id === id).length > 1));
    throw new Error("Duplicate dataset ids");
  }

  console.log("Datasets validated successfully");
  return result.data;
}

validateDatasets();