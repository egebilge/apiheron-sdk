import { afterEach, expect, test } from "bun:test";
import { capture, drainRequests } from "../src/capture";
import {
  foldName,
  isMaskedName,
  isPersonalValue,
  setMaskFields,
} from "../src/mask";
import { setCaptureRequests, setCaptureResponses } from "../src/replay";

afterEach(() => {
  setMaskFields([]);
  setCaptureRequests(false);
  setCaptureResponses(false);
  drainRequests();
});

test("names fold to lowercase alphanumerics, Turkish letters included", () => {
  expect(foldName("TC_Kimlik_No")).toBe("tckimlikno");
  expect(foldName("Doğum Tarihi")).toBe("dogumtarihi");
  expect(foldName("İSİM")).toBe("isim");
  expect(foldName("Db_ID")).toBe("dbid");
});

test("maskFields: exact names and patterns on the folded name", () => {
  setMaskFields(["Telefon", /soyad/, /(?<!o)tel\d*$/g]);
  expect(isMaskedName("telefon")).toBe(true);
  expect(isMaskedName("Fat_Soyadi")).toBe(true);
  expect(isMaskedName("CepTel")).toBe(true);
  // A g flag would make the second test start mid-string.
  expect(isMaskedName("EvTel")).toBe(true);
  expect(isMaskedName("Otel")).toBe(false);
  expect(isMaskedName("Kasa_Sifresi")).toBe(true); // credentials: always
  expect(isMaskedName("Db_Id")).toBe(false);
});

test.each([
  "ada@example.com",
  "10000000146", // T.C. kimlik no, valid checksum
  10000000146,
  "4111 1111 1111 1111",
  "TR33 0006 1005 1978 6457 8413 26",
  "0532 123 45 67",
  "+90 532 123 45 67",
])("personal value: %p", (value) => {
  expect(isPersonalValue(value)).toBe(true);
});

test.each([
  "12345678901", // fails the T.C. checksum
  1795505512994, // epoch ms
  "1795505512994",
  "12345.67",
  86,
  "Sat_Paket",
  "2026-11-24T10:15:37Z",
  "0212 123 45 67", // landline: names catch these
])("not personal: %p", (value) => {
  expect(isPersonalValue(value)).toBe(false);
});

test("captured URL, query, body and response are masked", () => {
  setCaptureRequests(true);
  setCaptureResponses(true);
  setMaskFields([/soyad/]);
  capture({
    source: "fetch",
    status: 200,
    start: 0,
    bytes: 2,
    method: "POST",
    url: "https://api.test/guests/10000000146?Db_Id=80&mail=ada@example.com",
    body: JSON.stringify({
      Soyadi: "Lovelace",
      Tutar: 120,
      Kart: "4111111111111111",
    }),
    data: { value: [{ Adi: "Ada", Fat_Soyadi: "L", Tc: 10000000146, Id: 7 }] },
  });
  const replay = drainRequests()[0]?.replay;
  expect(replay?.url).toBe("https://api.test/guests/***?Db_Id=80&mail=***");
  expect(JSON.parse(replay?.body ?? "")).toEqual({
    Soyadi: "***",
    Tutar: 120,
    Kart: "***",
  });
  expect(JSON.parse(replay?.response?.body ?? "")).toEqual({
    value: [{ Adi: "Ada", Fat_Soyadi: "***", Tc: "***", Id: 7 }],
  });
});

test("credential values and numeric mobile numbers are masked like personal values", () => {
  expect(
    isPersonalValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dGVzdHNpZ25hdHVyZQ"),
  ).toBe(true);
  expect(isPersonalValue("Bearer abcdef0123456789")).toBe(true);
  expect(isPersonalValue(5321234567)).toBe(true);
  expect(isPersonalValue(905321234567)).toBe(true);
  // A plain amount or id of the same length is not a mobile number.
  expect(isPersonalValue(1234567890)).toBe(false);
  expect(isMaskedName("x-api-key")).toBe(true);
  expect(isMaskedName("user[password]")).toBe(true);
});
