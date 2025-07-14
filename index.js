// Must be first line to load env vars
import { config } from "dotenv";
config();

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import pkg from "pg";
const { Client } = pkg;

// Setup PostgreSQL client
const db = new Client({
  host: "localhost",
  port: 5432,
  user: "todo_user",
  password: "todo_pass",
  database: "todo_db",
});
await db.connect();

await db.query(`
  CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'active'
  );
`);

// Define tools

const addTodo = tool(
  async ({ content }) => {
    await db.query("INSERT INTO todos (content) VALUES ($1)", [content]);
    return `Added: "${content}"`;
  },
  {
    name: "add_todo",
    description: "Add a new todo item",
    schema: z.object({
      content: z.string(),
    }),
  }
);

const deleteTodo = tool(
  async ({ keyword }) => {
    const res = await db.query(
      "UPDATE todos SET status='deleted' WHERE content ILIKE $1 RETURNING *",
      [`%${keyword}%`]
    );
    return res.rowCount > 0
      ? `Deleted ${res.rowCount} item(s)`
      : "No matching todos found.";
  },
  {
    name: "delete_todo",
    description: "Soft delete a todo by keyword",
    schema: z.object({
      keyword: z.string(),
    }),
  }
);

const searchTodo = tool(
  async ({ keywordOrId }) => {
    const idNum = parseInt(keywordOrId);
    let res;
    if (!isNaN(idNum)) {
      res = await db.query("SELECT * FROM todos WHERE id=$1", [idNum]);
    } else {
      res = await db.query(
        "SELECT * FROM todos WHERE content ILIKE $1 AND status='active'",
        [`%${keywordOrId}%`]
      );
    }

    return res.rows.length > 0
      ? res.rows.map((r) => `#${r.id} - ${r.content} [${r.status}]`).join("\n")
      : "No todos found.";
  },
  {
    name: "search_todo",
    description: "Search todos by keyword or ID",
    schema: z.object({
      keywordOrId: z.string(),
    }),
  }
);

const restoreTodo = tool(
  async ({ keyword }) => {
    const res = await db.query(
      "UPDATE todos SET status='active' WHERE content ILIKE $1 AND status='deleted' RETURNING *",
      [`%${keyword}%`]
    );
    return res.rowCount > 0
      ? `Restored ${res.rowCount} item(s)`
      : "No deleted todos matched.";
  },
  {
    name: "restore_todo",
    description: "Restore previously deleted todos",
    schema: z.object({
      keyword: z.string(),
    }),
  }
);

const readTodo = tool(
  async ({ showAll }) => {
    const query = showAll
      ? "SELECT * FROM todos ORDER BY id DESC"
      : "SELECT * FROM todos WHERE status='active' ORDER BY id DESC";
    const res = await db.query(query);
    return res.rows.length > 0
      ? res.rows.map((r) => `#${r.id} - ${r.content} [${r.status}]`).join("\n")
      : "No todos found.";
  },
  {
    name: "read_todo",
    description: "Read all todos",
    schema: z.object({
      showAll: z.boolean().default(false),
    }),
  }
);

// Setup Gemini model
const model = new ChatGoogleGenerativeAI({
  model: "gemini-2.0-flash-001",
  apiKey: process.env.GOOGLE_API_KEY,
  maxOutputTokens: 2048,
});

// Create agent with LangSmith config including API key
const agent = createReactAgent({
  llm: model,
  tools: [addTodo, deleteTodo, searchTodo, restoreTodo, readTodo],
  langsmith: {
    apiKey: process.env.LANGSMITH_API_KEY,
    projectName: "todo-app",
  },
});

// CLI chat loop
import { stdin as input, stdout as output } from "process";
import readlineModule from "readline";

const rl = readlineModule.createInterface({ input, output });

async function chatLoop() {
  console.log("Welcome to Todo Chat! Type 'exit' to quit.\n");

  while (true) {
    const userInput = await new Promise((res) => rl.question("You: ", res));
    if (userInput.toLowerCase() === "exit") break;

    try {
      const result = await agent.invoke({
        messages: [{ role: "user", content: userInput }],
      });

      console.log("Bot:", result.messages[result.messages.length - 1].content);
    } catch (error) {
      console.error("Error:", error);
    }
  }

  rl.close();
  await db.end();
  console.log("Goodbye!");
}

chatLoop();
 