import { FastifyInstance } from "fastify";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// Request schema validation
const filterGeneratorRequestSchema = z.object({
  prompt: z.string(),
  contextData: z.record(z.any()),
  schemaDescription: z.string(),
  currentFilter: z.any().nullable().optional(),
  useGemini: z.boolean().optional().default(false),
});

type FilterGeneratorRequest = {
  Body: z.infer<typeof filterGeneratorRequestSchema>;
};

export default async function filterGeneratorRoutes(fastify: FastifyInstance) {
  fastify.post<FilterGeneratorRequest>(
    "/api/filter-generator",
    async (request, reply) => {
      try {
        // Validate request
        const validation = filterGeneratorRequestSchema.safeParse(request.body);
        if (!validation.success) {
          return reply.status(400).send({
            error: "Invalid request",
            details: validation.error.format(),
          });
        }

        const {
          prompt,
          contextData,
          schemaDescription,
          currentFilter,
          useGemini,
        } = request.body;

        // Create the prompt template with current filter state if available
        const currentFilterInfo = currentFilter
          ? `\nCURRENT FILTER STATE:
${escapeCurlyBraces(JSON.stringify(currentFilter, null, 2))}`
          : "";

        const promptTemplate = ChatPromptTemplate.fromMessages([
          [
            "system",
            `You are a helpful assistant that generates filter configurations for data visualization.
Based on the user's request, you should generate a valid JSON object that matches the following schema description:

${escapeCurlyBraces(schemaDescription)}

Here is the context data for available filter options:
${escapeCurlyBraces(JSON.stringify(contextData, null, 2))}${currentFilterInfo}

IMPORTANT REQUIREMENTS:
1. Your response should ONLY include valid JSON representing the filter configuration.
2. Do not include any explanations, markdown formatting, or code blocks.
3. Just return the raw JSON object.
4. If the user's request is asking to modify the current filter (e.g., "add", "remove", "update", "change", "include", "exclude", etc.), modify the existing filter state intelligently.
5. If the user's request seems to be asking for entirely new data without referencing the current state, create a new filter based on their request.
6. Always ensure the amountRange field is an object with min and max properties, never null.
7. If the user ask for all the options in a field, return an empty array for that field or the default empty value, as this value is selecting all the options.`,
          ],
          [
            "user",
            `${
              currentFilter ? "Based on my current filter, " : ""
            }Generate a filter configuration for the following request: "${prompt}"`,
          ],
        ]);

        let model;

        if (useGemini) {
          // Use Gemini model with LangChain
          model = new ChatGoogleGenerativeAI({
            apiKey: process.env.GEMINI_API_KEY,
            model: process.env.GEMINI_MODEL as string,
            temperature: 0.2,
            maxOutputTokens: 2048,
            json: true,
          });
          fastify.log.info(`Using Gemini model: ${process.env.GEMINI_MODEL}`);
        } else {
          // Use OpenAI model
          model = new ChatOpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            modelName: process.env.OPENAI_MODEL as string,
            temperature: 0.2,
            configuration: {
              baseURL: process.env.OPENAI_API_URL as string,
            },
          });
          fastify.log.info(`Using OpenAI model: ${process.env.OPENAI_MODEL}`);
        }

        // Create the LangChain chain
        const chain = promptTemplate.pipe(model).pipe(new StringOutputParser());

        // Execute the chain
        fastify.log.info(`Sending request to LLM: ${prompt}`);
        const responseContent = await chain.invoke({});

        if (!responseContent) {
          throw new Error("Empty response from LLM");
        }

        // Try to parse the response as JSON
        try {
          // Extract JSON if it's wrapped in backticks or code blocks
          let jsonStr = responseContent;
          if (jsonStr.includes("```json")) {
            jsonStr = jsonStr.split("```json")[1].split("```")[0].trim();
          } else if (jsonStr.includes("```")) {
            jsonStr = jsonStr.split("```")[1].split("```")[0].trim();
          }

          let filter = JSON.parse(jsonStr);

          // Ensure object fields are always properly structured
          if (!filter.amountRange || filter.amountRange === null) {
            filter.amountRange = { min: null, max: null };
          }

          if (!filter.yearRange || filter.yearRange === null) {
            filter.yearRange = { from: null, to: null };
          }

          // Ensure all required fields are present with appropriate defaults
          if (!filter.entityType) filter.entityType = [];
          if (!filter.county) filter.county = [];
          if (!filter.functionalCategory) filter.functionalCategory = [];
          if (!filter.economicCategory) filter.economicCategory = [];
          if (!filter.searchQuery) filter.searchQuery = "";

          fastify.log.info(`Generated filter: ${JSON.stringify(filter)}`);
          return reply.send({ filter });
        } catch (error) {
          fastify.log.error(
            `Failed to parse LLM response as JSON: ${responseContent}`
          );
          return reply.status(500).send({
            error: "Failed to parse LLM response as JSON",
            responseContent, // Include the raw response for debugging
          });
        }
      } catch (error) {
        // Log the error
        fastify.log.error(`Error generating filter: ${error}`);

        // Return error response
        return reply.status(500).send({
          error: "Failed to generate filter",
        });
      }
    }
  );
}

export function escapeCurlyBraces(text: string) {
  return text.replace(/{/g, "{{").replace(/}/g, "}}");
}
