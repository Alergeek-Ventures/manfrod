export function celsiusToFahrenheit(celsius: number): number {
  return Math.round(((celsius * 9) / 5) * 100 + 3200) / 100;
}
