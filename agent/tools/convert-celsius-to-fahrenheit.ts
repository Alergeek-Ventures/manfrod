import { z } from "zod";
import { celsiusToFahrenheit } from "../lib/temperature.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Convert a temperature from degrees Celsius to degrees Fahrenheit (F = C × 9/5 + 32), rounded to two decimals. Use when someone asks for a Celsius temperature in Fahrenheit.",
  inputSchema: z.object({
    celsius: z.number().describe("Temperature in degrees Celsius"),
  }),
  async execute({ celsius }) {
    return `${celsius}°C = ${celsiusToFahrenheit(celsius)}°F`;
  },
});
