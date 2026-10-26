/**
 * 最小类型声明：lunar-javascript 只发 index.js、不带 .d.ts。
 * 本插件只用 Solar → Lunar 的农历/节气换算，故只声明用到的成员。
 */
declare module "lunar-javascript" {
  export class Solar {
    static fromYmd(year: number, month: number, day: number): Solar;
    static fromYmdHms(year: number, month: number, day: number, hour: number, minute: number, second: number): Solar;
    getLunar(): Lunar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
  }

  export class Lunar {
    getMonthInChinese(): string;
    getDayInChinese(): string;
    /** 当日节气名（若不在节气当日则返回空串） */
    getJieQi(): string;
  }
}
