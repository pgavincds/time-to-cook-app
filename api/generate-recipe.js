const {
  DEFAULT_MODEL,
  fullRecipeSchema,
  sendJson,
  ingredientId,
  parseJsonBody,
  callOpenAiJson,
  baseWarnings,
  mockFullRecipe
} = require("./_openaiTimeToCook");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST JSON with selected recipe option, ingredients, and safety settings." });

  try {
    const body = await parseJsonBody(req);
    const recipeOption = body.recipeOption || {};
    const ingredients = Array.isArray(body.ingredients) ? body.ingredients : [];
    const safetySettings = body.safetySettings || {};

    if (!process.env.OPENAI_API_KEY) {
      return sendJson(res, 200, mockFullRecipe(recipeOption, "OPENAI_API_KEY is not configured."));
    }

    const result = await callOpenAiJson({
      schemaName: "time_to_cook_full_recipe",
      schema: fullRecipeSchema,
      maxOutputTokens: 2800,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are Time to Cook, a child-safe cooking instructor. Generate one recipe with guided cooking steps. Each step must be safe, kid-friendly, and include a safety note when heat, knives, appliances, allergens, or adult supervision are involved. Do not describe steps as real generated video. Include optional video/search phrases only."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Selected recipe option: ${JSON.stringify(recipeOption)}\nConfirmed ingredients: ${JSON.stringify(ingredients)}\nSafety settings: ${JSON.stringify(safetySettings)}\nGenerate the full child-safe recipe. Avoid unsafe steps unless adult supervision is selected. Always check allergies before suggesting ingredients or steps. Include optional video/search phrases for each step.`
            }
          ]
        }
      ]
    });

    const recipe = result.recipe || mockFullRecipe(recipeOption).recipe;
    recipe.id = recipe.id || recipeOption.id || ingredientId(recipe.title);
    recipe.source = "OpenAI";

    sendJson(res, 200, {
      recipe,
      warnings: baseWarnings(result.warnings || []),
      providerInfo: {
        mode: "openai",
        recipeProvider: "OpenAI full recipe",
        model: DEFAULT_MODEL
      }
    });
  } catch (error) {
    sendJson(res, 200, mockFullRecipe(recipeOption, `OpenAI recipe generation failed: ${error.message}`));
  }
};
