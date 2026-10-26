import { z } from "zod";
import { celsiusToFahrenheit } from "../lib/temperature.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Convert a temperature from degrees Celsius to degrees Fahrenheit (rounded to 2 decimals).",
  inputSchema: z.object({ celsius: z.number().finite().describe("Temperature in degrees Celsius") }),
  async execute({ celsius }) {
    return `${celsius}°C = ${celsiusToFahrenheit(celsius)}°F`;
  },
});
