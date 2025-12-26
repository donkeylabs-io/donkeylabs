// Core exports - generic utilities and types
export * from "./errors";
export * from "./interfaces";
export * from "./types";
export * from "./jwt";
export * from "./formatting";
export * from "./client/APIClient";
export * from "./dates";

import moment from "moment/min/moment-with-locales";

/**
 * Get time since now as a human-readable string
 * @param utcDate - UTC date to compare against
 * @param locale - Locale for formatting (default: "en")
 */
export const timeSinceNowString = (utcDate: Date, locale: string = "en"): string => {
  return moment.utc(utcDate).local().locale(locale).fromNow();
};

/**
 * Get full date string in localized format
 * @param date - Date to format
 * @param locale - Locale for formatting (default: "en")
 */
export const getFullDateString = (date: Date, locale: string = "en") => {
  return moment.utc(date).locale(locale).format("DD [de] MMMM [de] YYYY");
};

export const toUTC = (date: Date) => {
  return moment(date).utc().toDate();
};

export const stringToUTC = (utcDate: string) => {
  return moment.utc(utcDate).toDate();
};

export const getUTCDate = () => {
  return moment.utc().toDate();
};
