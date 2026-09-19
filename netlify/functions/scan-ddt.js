// netlify/functions/scan-ddt.js
//
// Legge (OCR "intelligente") una foto di DDT/fattura/etichetta fornitore usando
// l'API Anthropic direttamente dal server, con una chiave posseduta da DoubleB
// (variabile d'ambiente ANTHROPIC_API_KEY su Netlify). In questo modo la lettura
// funziona sempre, per qualunque dipendente, indipendentemente dai permessi del
// singolo account Claude di chi ha creato l'app: prima girava dentro un Artifact
// Claude e dipendeva da un permesso ("lettura immagini") che non è garantito per
// tutti gli account — da qui lo spostamento su questo endpoint proprio.
//
// Nessuna dipendenza esterna: usa fetch (disponibile nel runtime Node 18+ di
// Netlify Functions) per chiamare direttamente https://api.anthropic.com/v1/messages,
// così non serve "npm install" prima di deployare.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "method_not_allowed" }) };
  }
  if (!ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "missing_api_key", message: "ANTHROPIC_API_KEY non configurata su Netlify (Site settings > Environment variables)." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_json" }) };
  }

  const { imageBase64, mimeType, articoli } = payload;
  if (!imageBase64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "missing_image" }) };
  }

  const isPdf = mimeType === "application/pdf";
  const mediaType = isPdf ? "application/pdf" : (mimeType || "image/jpeg");
  const listaArticoli = Array.isArray(articoli) ? articoli.slice(0, 300) : [];

  const promptText =
    "Questa è la foto (o scansione) di un documento di trasporto (DDT), fattura o etichetta di un fornitore " +
    "alimentare ricevuta da un burger bar/factory. Estrai ogni riga di merce effettivamente ricevuta.\n" +
    "Articoli già in anagrafica (usa l'id se una riga corrisponde chiaramente, altrimenti lascia null e riporta la descrizione così com'è). " +
    "Un fornitore può scrivere lo stesso articolo con parole leggermente diverse da quelle in anagrafica (ordine delle parole, abbreviazioni, " +
    "un dettaglio in più o in meno): usa buon senso e abbina comunque l'id quando si tratta chiaramente dello stesso prodotto, non solo in " +
    "caso di corrispondenza esatta: " +
    JSON.stringify(listaArticoli) + "\n" +
    "Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questa forma esatta:\n" +
    '{"tipo": "ddt"|"nota"|"altro", "ddt": string|null, "data": "YYYY-MM-DD"|null, "fornitore": string|null, ' +
    '"righe": [{"descrizione": string, "id": string|null, "lotto": string|null, "scadenza": "YYYY-MM-DD"|null, "quantita": number|null, "colli": number|null, ' +
    '"nato": string|null, "allevato": string|null, "macellato": string|null, "sezionato": string|null}]}\n' +
    "La foto può essere ruotata o storta: leggila comunque orientandola mentalmente nel verso giusto. " +
    "Regole: \"tipo\" è \"ddt\" per un documento di trasporto o fattura, \"nota\" per una nota di tracciabilità della carne (vedi sotto), \"altro\" negli altri casi. " +
    "\"ddt\" è il numero del documento di trasporto o fattura, se presente. \"data\" è la data del documento. " +
    "\"fornitore\" è la ragione sociale dell'azienda che ha EMESSO il documento: quella riportata nell'intestazione/mittente del documento stesso, " +
    "di solito insieme a partita IVA, codice fiscale o indirizzo della sede, in alto nel documento o vicino alla firma/timbro. " +
    "NON è il destinatario (chi riceve, es. DoubleB) e NON è un marchio di prodotto citato nella descrizione degli articoli: un documento può " +
    "elencare merce di marchi noti (es. \"AIA\", \"Fileni\", ecc.) anche se chi lo ha emesso e lo consegna è un distributore/grossista diverso " +
    "(es. \"BP Food Srl\") — in quel caso \"fornitore\" è il distributore/grossista intestatario del documento, MAI il marchio del prodotto. " +
    "Se non riesci a individuare con certezza l'intestatario del documento, lascia \"fornitore\" a null piuttosto che indovinare usando un marchio di prodotto. " +
    "Per ogni riga: \"lotto\" è il numero di lotto del fornitore per quel prodotto, se stampato sul documento o sull'etichetta. " +
    "Se una riga riporta PIÙ lotti (es. \"Lotti: 319378 319381 319382\"), mettili TUTTI in \"lotto\", separati da uno spazio, nell'ordine in cui compaiono. " +
    "\"colli\" è il numero di colli/pezzi/confezioni della riga (la colonna \"Colli\", \"Pz\", \"N. pezzi\" o simile), se presente; altrimenti null. " +
    "Se il documento è una NOTA DI TRACCIABILITÀ della carne (una tabella con colonne tipo Lotto, Articolo, Peso netto, Nato in, Allevato in, " +
    "Macellato in, Sezionato in): fai UNA riga per ogni lotto della tabella, con \"lotto\" il suo numero, \"quantita\" il suo peso netto, e in " +
    "\"nato\", \"allevato\", \"macellato\", \"sezionato\" il testo esatto di quelle colonne (paese e, se c'è, il bollo CE, es. \"Polonia PL14200205WE\"). " +
    "In un DDT normale lascia quei quattro campi a null. Nella nota, \"fornitore\" è l'azienda che l'ha emessa (spesso nell'intestazione, la stessa del DDT) e \"ddt\" il numero del DDT a cui la nota si riferisce, se scritto. " +
    "\"scadenza\" è la data di scadenza/TMC se presente, altrimenti null (molti prodotti come la carne fresca non la riportano: va bene null). " +
    "\"quantita\" è la quantità numerica ricevuta di quella riga (kg, litri, pezzi...), senza unità di misura nel valore. " +
    "Ignora spese di trasporto, note, totali e righe che non sono merce fisica. " +
    "Attenzione a non confondere il numero del documento con un lotto: se un codice è chiaramente etichettato come \"lotto\"/\"lot\" " +
    "(anche vicino all'intestazione o al nome del prodotto), quel codice va SOLO nel campo \"lotto\" della riga corrispondente, mai in \"ddt\". " +
    "Se non trovi un numero di documento chiaramente etichettato come tale (es. \"DDT n.\", \"Fattura n.\", \"Bolla n.\"), lascia \"ddt\" a null " +
    "invece di usare un codice lotto o un altro riferimento ambiguo.";

  const documentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } };

  const body = {
    model: MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [documentBlock, { type: "text", text: promptText }],
      },
    ],
  };

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    const raw = await resp.text();
    if (!resp.ok) {
      console.error("Anthropic API error", resp.status, raw);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "anthropic_error", status: resp.status, detail: raw.slice(0, 500) }),
      };
    }

    const data = JSON.parse(raw);
    const textOut = (data.content || []).map((b) => b.text || "").join("").trim();
    const jsonText = extractJson(textOut);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error("Could not parse model output as JSON:", textOut);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "parse_error", raw: textOut.slice(0, 800) }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server_error", message: String(e && e.message || e) }) };
  }
};

// Il modello a volte avvolge il JSON in ```json ... ``` nonostante le istruzioni:
// questa funzione estrae il primo blocco { ... } valido dal testo di risposta.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text;
}
