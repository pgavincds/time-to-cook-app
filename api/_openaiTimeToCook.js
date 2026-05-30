const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}

function ingredientId(name) {
  return normalizeName(name).replace(/\s+/g, "-") || "ingredient";
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES * 2) throw new Error("Request body is too large for prototype analysis.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(req, body) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!boundaryMatch) return { fields: {}, files: {} };

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const bodyText = body.toString("binary");
  const parts = bodyText.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};

  parts.forEach((part) => {
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const rawHeaders = trimmed.slice(0, headerEnd);
    const rawContent = trimmed.slice(headerEnd + 4);
    const nameMatch = rawHeaders.match(/name="([^"]+)"/i);
    if (!nameMatch) return;

    const name = nameMatch[1];
    const filenameMatch = rawHeaders.match(/filename="([^"]*)"/i);
    const contentTypeMatch = rawHeaders.match(/content-type:\s*([^\r\n]+)/i);
    const contentBuffer = Buffer.from(rawContent, "binary");

    if (filenameMatch && filenameMatch[1]) {
      files[name] = {
        filename: filenameMatch[1],
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
        buffer: contentBuffer
      };
    } else {
      fields[name] = contentBuffer.toString("utf8");
    }
  });

  return { fields, files };
}

async function parseJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function safeParseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "{}");
  } catch (_error) {
    return fallback;
  }
}

function toDataUrl(file) {
  if (!file || !file.buffer || !file.buffer.length) return "";
  return `data:${file.contentType || "image/jpeg"};base64,${file.buffer.toString("base64")}`;
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  (data.output || []).forEach((item) => {
    (item.content || []).forEach((content) => {
      if (typeof content.text === "string") parts.push(content.text);
      if (typeof content.output_text === "string") parts.push(content.output_text);
    });
  });
  return parts.join("\n").trim();
}

async function callOpenAiJson({ input, schemaName, schema, maxOutputTokens = 2500 }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema
        }
      },
      max_output_tokens: maxOutputTokens
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI returned ${response.status}`);
  }

  const outputText = extractOutputText(data);
  if (!outputText) throw new Error("OpenAI did not return JSON text.");
  return JSON.parse(outputText);
}

const ingredientAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    detectedIngredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          confidence: { type: "number" },
          confidenceLevel: { type: "string", enum: ["high", "medium", "low"] },
          adultHelpRequired: { type: "boolean" },
          allergyConcern: { type: "string" },
          notes: { type: "string" }
        },
        required: ["id", "name", "confidence", "confidenceLevel", "adultHelpRequired", "allergyConcern", "notes"]
      }
    },
    warnings: { type: "array", items: { type: "string" } },
    needsManualConfirmation: { type: "boolean" }
  },
  required: ["detectedIngredients", "warnings", "needsManualConfirmation"]
};

const recipeOptionsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    recipeOptions: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          difficulty: { type: "string" },
          estimatedTime: { type: "string" },
          requiredTools: { type: "array", items: { type: "string" } },
          adultHelpRequired: { type: "boolean" },
          adultHelpWarnings: { type: "array", items: { type: "string" } },
          safetyNotes: { type: "array", items: { type: "string" } },
          fitReason: { type: "string" },
          ingredientsUsed: { type: "array", items: { type: "string" } },
          missingIngredients: { type: "array", items: { type: "string" } }
        },
        required: ["id", "title", "difficulty", "estimatedTime", "requiredTools", "adultHelpRequired", "adultHelpWarnings", "safetyNotes", "fitReason", "ingredientsUsed", "missingIngredients"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["recipeOptions", "warnings"]
};

const fullRecipeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    recipe: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        ingredients: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } },
        estimatedTime: { type: "string" },
        difficulty: { type: "string" },
        adultHelpRequired: { type: "boolean" },
        adultHelpWarnings: { type: "array", items: { type: "string" } },
        safetyNotes: { type: "array", items: { type: "string" } },
        steps: {
          type: "array",
          minItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              instruction: { type: "string" },
              safetyNote: { type: "string" },
              emoji: { type: "string" },
              videoSearchPhrase: { type: "string" }
            },
            required: ["id", "instruction", "safetyNote", "emoji", "videoSearchPhrase"]
          }
        }
      },
      required: ["id", "title", "ingredients", "tools", "estimatedTime", "difficulty", "adultHelpRequired", "adultHelpWarnings", "safetyNotes", "steps"]
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["recipe", "warnings"]
};

function baseWarnings(extra = []) {
  return [
    "AI can help identify foods, but it cannot guarantee allergen safety.",
    "Always check ingredients with an adult if you have allergies.",
    "Ask an adult before using heat, knives, appliances, or boiling water.",
    ...extra
  ];
}

function mockIngredients(reason) {
  return {
    detectedIngredients: [
      { id: "pasta", name: "pasta", confidence: 0.72, confidenceLevel: "medium", adultHelpRequired: true, allergyConcern: "wheat/gluten", notes: "Common pantry item; confirm the box label with an adult." },
      { id: "cheese", name: "cheese", confidence: 0.7, confidenceLevel: "medium", adultHelpRequired: false, allergyConcern: "milk/dairy", notes: "Check dairy allergies with an adult." },
      { id: "milk", name: "milk", confidence: 0.66, confidenceLevel: "medium", adultHelpRequired: false, allergyConcern: "milk/dairy", notes: "Confirm the container and expiration date with an adult." },
      { id: "butter", name: "butter", confidence: 0.61, confidenceLevel: "low", adultHelpRequired: false, allergyConcern: "milk/dairy", notes: "Low-confidence demo item; please confirm manually." }
    ],
    warnings: baseWarnings(["Mock fallback is being used because OpenAI is not configured or the request failed.", reason].filter(Boolean)),
    needsManualConfirmation: true,
    providerInfo: { mode: "mock", ingredientProvider: "mock fallback", model: "none" }
  };
}

function mockRecipeOptions(reason) {
  return {
    recipeOptions: [
      { id: "mac-and-cheese", title: "Mac and Cheese", difficulty: "Medium", estimatedTime: "20 min", requiredTools: ["stove", "pot", "strainer", "spoon"], adultHelpRequired: true, adultHelpWarnings: ["Needs adult help for boiling water and draining pasta."], safetyNotes: ["Uses heat and boiling water."], fitReason: "Uses pasta, cheese, milk, and butter.", ingredientsUsed: ["pasta", "cheese", "milk", "butter"], missingIngredients: [] },
      { id: "cheese-sandwich", title: "Cheese Sandwich", difficulty: "Easy", estimatedTime: "10 min", requiredTools: ["plate", "butter knife"], adultHelpRequired: false, adultHelpWarnings: ["Ask before using even a butter knife."], safetyNotes: ["Check dairy and wheat allergies."], fitReason: "Uses cheese and simple pantry items.", ingredientsUsed: ["cheese"], missingIngredients: ["bread"] },
      { id: "fruit-smoothie", title: "Fruit Smoothie", difficulty: "Easy", estimatedTime: "8 min", requiredTools: ["blender", "cup"], adultHelpRequired: true, adultHelpWarnings: ["Ask an adult before using a blender."], safetyNotes: ["Blender blades are sharp; check dairy allergies."], fitReason: "Good no-stove option if fruit and yogurt are available.", ingredientsUsed: ["milk"], missingIngredients: ["banana", "berries", "yogurt"] }
    ],
    warnings: baseWarnings([reason].filter(Boolean)),
    providerInfo: { mode: "mock", recipeProvider: "mock fallback", model: "none" }
  };
}

function mockFullRecipe(option = {}, reason) {
  const title = option.title || "Mac and Cheese";
  return {
    recipe: {
      id: option.id || ingredientId(title),
      title,
      ingredients: option.ingredientsUsed?.length ? option.ingredientsUsed : ["pasta", "cheese", "milk", "butter"],
      tools: option.requiredTools?.length ? option.requiredTools : ["stove", "pot", "strainer", "spoon"],
      estimatedTime: option.estimatedTime || "20 min",
      difficulty: option.difficulty || "Medium",
      adultHelpRequired: option.adultHelpRequired !== false,
      adultHelpWarnings: option.adultHelpWarnings?.length ? option.adultHelpWarnings : ["Needs adult help for heat, boiling water, or appliances."],
      safetyNotes: option.safetyNotes?.length ? option.safetyNotes : baseWarnings(),
      steps: [
        { id: "step-1", instruction: "Ask an adult to review the recipe and ingredients.", safetyNote: "An adult must check allergies and tools before cooking.", emoji: "👀", videoSearchPhrase: "kid safe cooking adult supervision" },
        { id: "step-2", instruction: "Wash your hands and clean your cooking space.", safetyNote: "Clean hands help keep food safe.", emoji: "🧼", videoSearchPhrase: "how kids wash hands before cooking" },
        { id: "step-3", instruction: "Gather your ingredients and tools.", safetyNote: "Ask for help with heavy, sharp, or hot tools.", emoji: "🥣", videoSearchPhrase: "kids gather cooking ingredients safely" },
        { id: "step-4", instruction: "Follow each adult-approved cooking direction slowly.", safetyNote: "Pause and ask for help with heat, knives, appliances, or boiling water.", emoji: "▶️", videoSearchPhrase: "safe cooking steps for kids" },
        { id: "step-5", instruction: "Enjoy when an adult says the food is ready.", safetyNote: "Let hot food cool before tasting.", emoji: "🎉", videoSearchPhrase: "how to taste hot food safely" }
      ]
    },
    warnings: baseWarnings([reason].filter(Boolean)),
    providerInfo: { mode: "mock", recipeProvider: "mock fallback", model: "none" }
  };
}

module.exports = {
  DEFAULT_MODEL,
  MAX_IMAGE_BYTES,
  ingredientAnalysisSchema,
  recipeOptionsSchema,
  fullRecipeSchema,
  sendJson,
  normalizeName,
  ingredientId,
  readRequestBody,
  parseMultipart,
  parseJsonBody,
  safeParseJson,
  toDataUrl,
  callOpenAiJson,
  baseWarnings,
  mockIngredients,
  mockRecipeOptions,
  mockFullRecipe
};
