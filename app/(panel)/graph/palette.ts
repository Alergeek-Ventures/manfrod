export type ColorBy = "project" | "author" | "status";

const SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"],
};

export const SERIES_SLOTS = SERIES.light.length;

export interface GraphTheme {
  dark: boolean;
  series: string[];
  other: string;
  dim: string;
  text: string;
  edge: string;
  edgeFocus: string;
  surface: string;
  border: string;
}

export function graphTheme(dark: boolean): GraphTheme {
  return dark
    ? {
        dark,
        series: SERIES.dark,
        other: "#8a8984",
        dim: "#2c2c2a",
        text: "#c3c2b7",
        edge: "#2e2e2b",
        edgeFocus: "#a3a299",
        surface: "#1a1a19",
        border: "#3a3a37",
      }
    : {
        dark,
        series: SERIES.light,
        other: "#9a9992",
        dim: "#e6e5e0",
        text: "#52514c",
        edge: "#e2e1dc",
        edgeFocus: "#6b6a64",
        surface: "#fcfcfb",
        border: "#dcdbd5",
      };
}
