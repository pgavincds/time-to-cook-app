const {
  DEFAULT_MODEL,
  MAX_IMAGE_BYTES,
  ingredientAnalysisSchema,
  sendJson,
  ingredientId,
  readRequestBody,
  parseMultipart,
  safeParseJson,
  toDataUrl,
  callOpenAiJson,
  baseWarnings,
  mockIngredients
} = require("./_openaiTimeToCook");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST multipart/form-data with an image file." });

  try {
    const body = await readRequestBody(req);
    const { fields, files } = parseMultipart(req, body);
    const safetySettings = safeParseJson(fields.safetySettings, {});
    const imageFile = files.image;

    if (!process.env.OPENAI_API_KEY) {
      return sendJson(res, 200, mockIngredients("OPENAI_API_KEY is not configured."));
    }
    if (!imageFile || !imageFile.buffer.length) {
      return sendJson(res, 200, mockIngredients("No photo was uploaded. Please manually confirm ingredients."));
    }
    if (imageFile.buffer.length > MAX_IMAGE_BYTES) {
      return sendJson(res, 200, mockIngredients("The uploaded image was too large for this prototype endpoint."));
    }

    const imageUrl = toDataUrl(imageFile);
    const result = await callOpenAiJson({
      schemaName: "time_to_cook_ingredient_analysis",
      schema: ingredientAnalysisSchema,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are Time to Cook, a child-safe cooking assistant. Identify only visible food ingredients. Never claim allergen certainty. If unsure, use low confidence and request manual confirmation."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Analyze this food/fridge/freezer photo for a child-safe cooking app. Return structured JSON only. Include confidence, adultHelpRequired, and allergyConcern for each visible ingredient. Safety settings: ${JSON.stringify(safetySettings)}.`
            },
            { type: "input_image", image_url: imageUrl, detail: "low" }
          ]
        }
      ],
      maxOutputTokens: 1000
    });

    const detectedIngredients = (result.detectedIngredients || []).map((ingredient) => ({
      ...ingredient,
      id: ingredient.id || ingredientId(ingredient.name)
    }));

    sendJson(res, 200, {
      detectedIngredients,
      warnings: baseWarnings(result.warnings || []),
      needsManualConfirmation: Boolean(result.needsManualConfirmation || detectedIngredients.some((item) => item.confidenceLevel === "low" || Number(item.confidence) < 0.65)),
      providerInfo: {
        mode: "openai",
        ingredientProvider: "OpenAI Vision",
        model: DEFAULT_MODEL
      }
    });
  } catch (error) {
    sendJson(res, 200, mockIngredients(`OpenAI ingredient analysis failed: ${error.message}`));
  }
};
