import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const agent = await createAgent({
  name: 'recipe-drinks-intel',
  version: '1.0.0',
  description: 'Recipe and cocktail intelligence for AI agents - search meals, drinks, ingredients, and get cooking instructions from TheMealDB and TheCocktailDB',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === API HELPERS ===
const MEAL_BASE = 'https://www.themealdb.com/api/json/v1/1';
const COCKTAIL_BASE = 'https://www.thecocktaildb.com/api/json/v1/1';

async function fetchJSON(url: string, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
  } catch (e: any) {
    clearTimeout(timeoutId);
    throw e;
  }
}

function extractMeal(meal: any) {
  if (!meal) return null;
  
  // Extract ingredients (up to 20)
  const ingredients: { ingredient: string; measure: string }[] = [];
  for (let i = 1; i <= 20; i++) {
    const ing = meal[`strIngredient${i}`];
    const measure = meal[`strMeasure${i}`];
    if (ing && ing.trim()) {
      ingredients.push({ ingredient: ing.trim(), measure: measure?.trim() || '' });
    }
  }
  
  return {
    id: meal.idMeal,
    name: meal.strMeal,
    category: meal.strCategory,
    area: meal.strArea,
    instructions: meal.strInstructions,
    thumbnail: meal.strMealThumb,
    youtube: meal.strYoutube || null,
    ingredients,
    tags: meal.strTags?.split(',').map((t: string) => t.trim()) || [],
    source: meal.strSource || null,
  };
}

function extractCocktail(drink: any) {
  if (!drink) return null;
  
  // Extract ingredients (up to 15)
  const ingredients: { ingredient: string; measure: string }[] = [];
  for (let i = 1; i <= 15; i++) {
    const ing = drink[`strIngredient${i}`];
    const measure = drink[`strMeasure${i}`];
    if (ing && ing.trim()) {
      ingredients.push({ ingredient: ing.trim(), measure: measure?.trim() || '' });
    }
  }
  
  return {
    id: drink.idDrink,
    name: drink.strDrink,
    category: drink.strCategory,
    alcoholic: drink.strAlcoholic,
    glass: drink.strGlass,
    instructions: drink.strInstructions,
    thumbnail: drink.strDrinkThumb,
    ingredients,
    iba: drink.strIBA || null, // International Bartenders Association category
  };
}

// === Serve icon ===
app.get('/icon.png', async (c) => {
  const iconPath = './icon.png';
  if (existsSync(iconPath)) {
    const icon = readFileSync(iconPath);
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  }
  return c.text('Icon not found', 404);
});

// === ERC-8004 Registration File ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://recipe-drinks-intel-production.up.railway.app';
  
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "recipe-drinks-intel",
    description: "Recipe and cocktail intelligence for AI agents. Search meals by name/category/ingredient, get cocktail recipes, and discover random dishes. Powered by TheMealDB and TheCocktailDB APIs.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

// === FREE ENDPOINT - Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - sample recipe and cocktail to try before you buy',
  input: z.object({}),
  price: "0.0001",
  handler: async () => {
    // Get random meal and cocktail
    const [mealData, drinkData] = await Promise.all([
      fetchJSON(`${MEAL_BASE}/random.php`),
      fetchJSON(`${COCKTAIL_BASE}/random.php`),
    ]);
    
    const meal = extractMeal(mealData.meals?.[0]);
    const drink = extractCocktail(drinkData.drinks?.[0]);
    
    return {
      output: {
        agent: 'recipe-drinks-intel',
        description: 'Recipe and cocktail intelligence for AI agents',
        dataSources: ['TheMealDB (live)', 'TheCocktailDB (live)'],
        sampleMeal: meal ? { name: meal.name, category: meal.category, area: meal.area } : null,
        sampleCocktail: drink ? { name: drink.name, category: drink.category, glass: drink.glass } : null,
        endpoints: [
          { key: 'meal-search', price: '$0.001', description: 'Search meals by name' },
          { key: 'meal-by-category', price: '$0.002', description: 'Get meals in a category' },
          { key: 'meal-by-ingredient', price: '$0.002', description: 'Find meals with specific ingredient' },
          { key: 'cocktail-search', price: '$0.001', description: 'Search cocktails by name' },
          { key: 'full-recipe', price: '$0.003', description: 'Get complete recipe with instructions' },
        ],
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 1 ($0.001) - Meal Search ===
addEntrypoint({
  key: 'meal-search',
  description: 'Search meals by name - returns matching recipes',
  input: z.object({ 
    query: z.string().describe('Meal name to search (e.g., "chicken", "pasta", "curry")'),
  }),
  price: "0.001", // $0.001
  handler: async (ctx) => {
    const data = await fetchJSON(`${MEAL_BASE}/search.php?s=${encodeURIComponent(ctx.input.query)}`);
    const meals = (data.meals || []).map(extractMeal).filter(Boolean);
    
    return {
      output: {
        query: ctx.input.query,
        count: meals.length,
        meals: meals.map(m => ({
          id: m!.id,
          name: m!.name,
          category: m!.category,
          area: m!.area,
          thumbnail: m!.thumbnail,
        })),
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 2 ($0.002) - Meals by Category ===
addEntrypoint({
  key: 'meal-by-category',
  description: 'Get meals in a specific category (Beef, Chicken, Seafood, Vegetarian, etc.)',
  input: z.object({ 
    category: z.string().describe('Category name (e.g., "Seafood", "Vegetarian", "Dessert")'),
    limit: z.number().optional().default(20).describe('Max results to return'),
  }),
  price: "0.002", // $0.002
  handler: async (ctx) => {
    const data = await fetchJSON(`${MEAL_BASE}/filter.php?c=${encodeURIComponent(ctx.input.category)}`);
    const meals = (data.meals || []).slice(0, ctx.input.limit);
    
    return {
      output: {
        category: ctx.input.category,
        count: meals.length,
        meals: meals.map((m: any) => ({
          id: m.idMeal,
          name: m.strMeal,
          thumbnail: m.strMealThumb,
        })),
        availableCategories: ['Beef', 'Chicken', 'Dessert', 'Lamb', 'Miscellaneous', 'Pasta', 'Pork', 'Seafood', 'Side', 'Starter', 'Vegan', 'Vegetarian', 'Breakfast', 'Goat'],
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 3 ($0.002) - Meals by Ingredient ===
addEntrypoint({
  key: 'meal-by-ingredient',
  description: 'Find meals containing a specific ingredient',
  input: z.object({ 
    ingredient: z.string().describe('Main ingredient (e.g., "chicken_breast", "salmon", "tofu")'),
    limit: z.number().optional().default(20).describe('Max results'),
  }),
  price: "0.002", // $0.002
  handler: async (ctx) => {
    const ingredient = ctx.input.ingredient.replace(/ /g, '_');
    const data = await fetchJSON(`${MEAL_BASE}/filter.php?i=${encodeURIComponent(ingredient)}`);
    const meals = (data.meals || []).slice(0, ctx.input.limit);
    
    return {
      output: {
        ingredient: ctx.input.ingredient,
        count: meals.length,
        meals: meals.map((m: any) => ({
          id: m.idMeal,
          name: m.strMeal,
          thumbnail: m.strMealThumb,
        })),
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 4 ($0.001) - Cocktail Search ===
addEntrypoint({
  key: 'cocktail-search',
  description: 'Search cocktails by name',
  input: z.object({ 
    query: z.string().describe('Cocktail name to search (e.g., "margarita", "mojito", "martini")'),
  }),
  price: "0.001", // $0.001
  handler: async (ctx) => {
    const data = await fetchJSON(`${COCKTAIL_BASE}/search.php?s=${encodeURIComponent(ctx.input.query)}`);
    const drinks = (data.drinks || []).map(extractCocktail).filter(Boolean);
    
    return {
      output: {
        query: ctx.input.query,
        count: drinks.length,
        cocktails: drinks.map(d => ({
          id: d!.id,
          name: d!.name,
          category: d!.category,
          alcoholic: d!.alcoholic,
          glass: d!.glass,
          thumbnail: d!.thumbnail,
        })),
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === PAID ENDPOINT 5 ($0.003) - Full Recipe ===
addEntrypoint({
  key: 'full-recipe',
  description: 'Get complete recipe with full instructions, ingredients, and measurements',
  input: z.object({ 
    mealId: z.string().describe('Meal ID from search results'),
  }),
  price: "0.003", // $0.003
  handler: async (ctx) => {
    const data = await fetchJSON(`${MEAL_BASE}/lookup.php?i=${ctx.input.mealId}`);
    const meal = extractMeal(data.meals?.[0]);
    
    if (!meal) {
      return { output: { error: 'Meal not found', mealId: ctx.input.mealId } };
    }
    
    return {
      output: {
        ...meal,
        fetchedAt: new Date().toISOString(),
        dataSource: 'TheMealDB (live)',
      }
    };
  },
});

// === BONUS: Random Discovery ===
addEntrypoint({
  key: 'random-discover',
  description: 'Get random meal and cocktail for discovery/inspiration',
  input: z.object({}),
  price: "0.001", // $0.001
  handler: async () => {
    const [mealData, drinkData] = await Promise.all([
      fetchJSON(`${MEAL_BASE}/random.php`),
      fetchJSON(`${COCKTAIL_BASE}/random.php`),
    ]);
    
    return {
      output: {
        meal: extractMeal(mealData.meals?.[0]),
        cocktail: extractCocktail(drinkData.drinks?.[0]),
        fetchedAt: new Date().toISOString(),
      }
    };
  },
});

// === ANALYTICS ENDPOINTS ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  price: "0.0001",
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return { 
      output: { 
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      } 
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  price: "0.0001",
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: "0.0001",
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🍽️🍸 Recipe & Drinks Intel running on port ${port}`);

export default { port, fetch: app.fetch };
