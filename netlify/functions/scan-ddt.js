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
    "Articoli già in anagrafica (usa l'id se una riga corrisponde chiaramente, altrimenti lascia null e riporta la descrizione così com'è): " +
    JSON.stringify(listaArticoli) + "\n" +
    "Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con questa forma esatta:\n" +
    '{"ddt": string|null, "data": "YYYY-MM-DD"|null, "fornitore": string|null, ' +
    '"righe": [{"descrizione": string, "id": string|null, "lotto": string|null, "scadenza": "YYYY-MM-DD"|null, "quantita": number|null}]}\n' +
    "Regole: \"ddt\" è il numero del documento di trasporto o fattura, se presente. \"data\" è la data del documento. " +
    "\"fornitore\" è la ragione sociale del fornitore che ha emesso il documento (chi consegna la merce), non il destinatario. " +
    "Per ogni riga: \"lotto\" è il numero di lotto del fornitore per quel prodotto, se stampato sul documento o sull'etichetta. " +
    "\"scadenza\" è la data di scadenza/TMC se presente, altrimenti null (molti prodotti come la carne fresca non la riportano: va bene null). " +
    "\"quantita\" è la quantità numerica ricevuta di quella riga (kg, litri, pezzi...), senza unità di misura nel valore. " +
    "Ignora spese di trasporto, note, totali e righe che non sono merce fisica.";

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

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text;
}
