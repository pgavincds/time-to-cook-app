const {
  DEFAULT_MODEL,
  recipeOptionsSchema,
  sendJson,
  ingredientId,
  parseJsonBody,
  callOpenAiJson,
  baseWarnings,
  mockRecipeOptions
} = require("./_openaiTimeToCook");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST JSON with confirmed ingredients and safety settings." });

  try {
    const body = await parseJsonBody(req);
    const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
    const safetySettings = body.safetySettings || {};

    if (!process.env.OPENAI_API_KEY) {
      const fallback = mockRecipeOptions("OPENAI_API_KEY is not configured.");
      return sendJson(res, 200, { suggestedRecipes: fallback.recipeOptions, warnings: fallback.warnings, providerInfo: fallback.providerInfo });
    }
    if (!ingredients.length) {
      const fallback = mockRecipeOptions("No confirmed ingredients were provided.");
      return sendJson(res, 200, { suggestedRecipes: fallback.recipeOptions, warnings: fallback.warnings, providerInfo: fallback.providerInfo });
    }

    const result = await callOpenAiJson({
      schemaName: "time_to_cook_recipe_options",
      schema: recipeOptionsSchema,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are Time to Cook, a child-safe recipe assistant. Suggest kid-friendly recipes only after considering allergies, available appliances, adult supervision, age/skill, and time. Avoid unsafe independent steps unless adult supervision is available. Do not guarantee allergen safety."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Confirmed ingredients: ${JSON.stringify(ingredients)}\nSafety settings: ${JSON.stringify(safetySettings)}\nReturn 3 to 5 recipe options. Always include allergy reminders, adult-help warnings, required tools, estimated time, difficulty, and a short reason each recipe fits the ingredients.`
            }
          ]
        }
      ],
      maxOutputTokens: 1800
    });

    const recipeOptions = (result.recipeOptions || []).map((option) => ({
      ...option,
      id: option.id || ingredientId(option.title),
      source: "OpenAI"
    }));

    sendJson(res, 200, {
      suggestedRecipes: recipeOptions,
      warnings: baseWarnings(result.warnings || []),
      providerInfo: {
        mode: "openai",
        recipeProvider: "OpenAI recipe options",
        model: DEFAULT_MODEL
      }
    });
  } catch (error) {
    const fallback = mockRecipeOptions(`OpenAI recipe suggestions failed: ${error.message}`);
    sendJson(res, 200, { suggestedRecipes: fallback.recipeOptions, warnings: fallback.warnings, providerInfo: fallback.providerInfo });
  }
};
