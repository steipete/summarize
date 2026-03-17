import { describe, expect, it } from "vitest";
import * as __testedFile from "../src/cache-keys";

describe("src/cache-keys.ts", () => {
  describe("hashString", () => {
    const { hashString } = __testedFile;
    // strValue: string

    it("should test hashString( mock-parameters.strValue 1 )", () => {
      const strValue: Parameters<typeof hashString>[0] = "";
      const __expectedResult: ReturnType<typeof hashString> =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      expect(hashString(strValue)).toEqual(__expectedResult);
    });

    it("should test hashString( mock-parameters.strValue 2 )", () => {
      const strValue: Parameters<typeof hashString>[0] = "abc";
      const __expectedResult: ReturnType<typeof hashString> =
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      expect(hashString(strValue)).toEqual(__expectedResult);
    });

    it("should test hashString( mock-parameters.strValue 3 )", () => {
      const strValue: Parameters<typeof hashString>[0] = "😉";
      const __expectedResult: ReturnType<typeof hashString> =
        "62e785e976a0c101316f55c805ee6275ac3cb4eaae2f8e4f3d725c2bd1cfa52f";
      expect(hashString(strValue)).toEqual(__expectedResult);
    });
  });

  describe("hashJson", () => {
    const { hashJson } = __testedFile;
    // jsonValue: unknown

    it("should test hashJson( mock-parameters.jsonValue 1 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = "";
      const __expectedResult: ReturnType<typeof hashJson> =
        "12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126";
      expect(hashJson(jsonValue)).toEqual(__expectedResult);
    });

    it("should test hashJson( mock-parameters.jsonValue 2 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = () => {};
      expect(() => hashJson(jsonValue)).toThrow(
        'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined',
      );
    });

    it("should test hashJson( mock-parameters.jsonValue 3 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = 0;
      const __expectedResult: ReturnType<typeof hashJson> =
        "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9";
      expect(hashJson(jsonValue)).toEqual(__expectedResult);
    });

    it("should test hashJson( mock-parameters.jsonValue 4 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = NaN;
      const __expectedResult: ReturnType<typeof hashJson> =
        "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";
      expect(hashJson(jsonValue)).toEqual(__expectedResult);
    });

    it("should test hashJson( mock-parameters.jsonValue 5 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = new Date("invalid");
      const __expectedResult: ReturnType<typeof hashJson> =
        "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";
      expect(hashJson(jsonValue)).toEqual(__expectedResult);
    });

    it("should test hashJson( mock-parameters.jsonValue 6 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = null;
      const __expectedResult: ReturnType<typeof hashJson> =
        "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";
      expect(hashJson(jsonValue)).toEqual(__expectedResult);
    });

    it("should test hashJson( mock-parameters.jsonValue 7 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = undefined;
      expect(() => hashJson(jsonValue)).toThrow(
        'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined',
      );
    });

    it("should test hashJson( mock-parameters.jsonValue 8 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = { valid: true };
      const __expectedResult: ReturnType<typeof hashJson> =
        "8daf09a6fc31937457dd77e9c25ce4b21349d605b561a8c5d557841bf964c9a0";
      expect(hashJson(jsonValue)).toEqual(__expectedResult);
    });

    it("should test hashJson( mock-parameters.jsonValue 9 )", () => {
      const jsonValue: Parameters<typeof hashJson>[0] = {};
      const __expectedResult: ReturnType<typeof hashJson> =
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
      expect(hashJson(jsonValue)).toEqual(__expectedResult);
    });
  });

  describe("normalizeContentForHash", () => {
    const { normalizeContentForHash } = __testedFile;
    // content: string

    it("should test normalizeContentForHash( mock-parameters.content 1 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = " \n ";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });

    it("should test normalizeContentForHash( mock-parameters.content 2 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = " \r\n ";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });

    it("should test normalizeContentForHash( mock-parameters.content 3 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = "";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });

    it("should test normalizeContentForHash( mock-parameters.content 4 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = "\r\n";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });

    it("should test normalizeContentForHash( mock-parameters.content 5 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = "\r\nabc";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "abc";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });

    it("should test normalizeContentForHash( mock-parameters.content 6 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = "abc";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "abc";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });

    it("should test normalizeContentForHash( mock-parameters.content 7 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = "abc\r\n pqr \r\nxyz";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "abc\n pqr \nxyz";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });

    it("should test normalizeContentForHash( mock-parameters.content 8 )", () => {
      const content: Parameters<typeof normalizeContentForHash>[0] = "abc\r\n";
      const __expectedResult: ReturnType<typeof normalizeContentForHash> = "abc";
      expect(normalizeContentForHash(content)).toEqual(__expectedResult);
    });
  });

  describe("extractTaggedBlock", () => {
    const { extractTaggedBlock } = __testedFile;
    // promptText: string
    // tag: "instructions" | "content"

    it("should test extractTaggedBlock( mock-parameters.promptText 1, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] = " <instructions> Do this </instructions> ";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "Do this";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 2, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] = "";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = null;
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 3, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] = "<instructions/>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = null;
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 4, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] = "<instructions></instructions>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("[bug] Nested Tags", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] =
        "<instructions>A<instructions>B</instructions>C</instructions>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "A<instructions>B";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 6, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] = "<instructions>Do <tag/> this</instructions>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "Do <tag/> this";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 7, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] = "<instructions>Do this</instructions>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "Do this";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 8, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] =
        "<instructions>Do this</instructions><content>Text</content>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "Do this";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 9, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] =
        "<instructions>Do this</instructions><instructions>Do that</instructions>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "Do this";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });

    it("should test extractTaggedBlock( mock-parameters.promptText 10, mock-parameters.tag 1 )", () => {
      const promptText: Parameters<typeof extractTaggedBlock>[0] = "<instructions>Part 1\nPart 2</instructions>";
      const tag: Parameters<typeof extractTaggedBlock>[1] = "instructions";
      const __expectedResult: ReturnType<typeof extractTaggedBlock> = "Part 1\nPart 2";
      expect(extractTaggedBlock(promptText, tag)).toEqual(__expectedResult);
    });
  });

  describe("buildPromptHash", () => {
    const { buildPromptHash } = __testedFile;
    // prompt: string

    it("should test buildPromptHash( mock-parameters.prompt 1 )", () => {
      const prompt: Parameters<typeof buildPromptHash>[0] = " Do this ";
      const __expectedResult: ReturnType<typeof buildPromptHash> =
        "1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70";
      expect(buildPromptHash(prompt)).toEqual(__expectedResult);
    });

    it("should test buildPromptHash( mock-parameters.prompt 2 )", () => {
      const prompt: Parameters<typeof buildPromptHash>[0] = "";
      const __expectedResult: ReturnType<typeof buildPromptHash> =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      expect(buildPromptHash(prompt)).toEqual(__expectedResult);
    });

    it("should test buildPromptHash( mock-parameters.prompt 3 )", () => {
      const prompt: Parameters<typeof buildPromptHash>[0] = "<instructions> Do this </instructions>";
      const __expectedResult: ReturnType<typeof buildPromptHash> =
        "1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70";
      expect(buildPromptHash(prompt)).toEqual(__expectedResult);
    });

    it("should test buildPromptHash( mock-parameters.prompt 4 )", () => {
      const prompt: Parameters<typeof buildPromptHash>[0] = "<instructions>Do this</instructions>";
      const __expectedResult: ReturnType<typeof buildPromptHash> =
        "1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70";
      expect(buildPromptHash(prompt)).toEqual(__expectedResult);
    });

    it("should test buildPromptHash( mock-parameters.prompt 5 )", () => {
      const prompt: Parameters<typeof buildPromptHash>[0] = "A <instructions>Do this</instructions> B";
      const __expectedResult: ReturnType<typeof buildPromptHash> =
        "1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70";
      expect(buildPromptHash(prompt)).toEqual(__expectedResult);
    });

    it("should test buildPromptHash( mock-parameters.prompt 6 )", () => {
      const prompt: Parameters<typeof buildPromptHash>[0] = "Do this";
      const __expectedResult: ReturnType<typeof buildPromptHash> =
        "1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70";
      expect(buildPromptHash(prompt)).toEqual(__expectedResult);
    });

    it("should test buildPromptHash( mock-parameters.prompt 7 )", () => {
      const prompt: Parameters<typeof buildPromptHash>[0] = "abc";
      const __expectedResult: ReturnType<typeof buildPromptHash> =
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      expect(buildPromptHash(prompt)).toEqual(__expectedResult);
    });
  });

  describe("buildPromptContentHash", () => {
    const { buildPromptContentHash } = __testedFile;
    // promptFallbackContent: { prompt: string; fallbackContent?: string; }

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 1 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = { prompt: "", fallbackContent: "" };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 2 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "",
        fallbackContent: "abc",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 3 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = { prompt: "", fallbackContent: null };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 4 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "",
        fallbackContent: undefined,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 5 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content></content>",
        fallbackContent: "",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 6 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content></content>",
        fallbackContent: "abc",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 7 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content></content>",
        fallbackContent: null,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 8 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content></content>",
        fallbackContent: undefined,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 9 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content>Text</content>",
        fallbackContent: "",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 10 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content>Text</content>",
        fallbackContent: "abc",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 11 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content>Text</content>",
        fallbackContent: null,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 12 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<content>Text</content>",
        fallbackContent: undefined,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 13 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<instructions>A<content>B</content>C</instructions>",
        fallbackContent: "",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 14 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<instructions>A<content>B</content>C</instructions>",
        fallbackContent: "abc",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 15 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<instructions>A<content>B</content>C</instructions>",
        fallbackContent: null,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 16 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "<instructions>A<content>B</content>C</instructions>",
        fallbackContent: undefined,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 17 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "A<content/>B",
        fallbackContent: "",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 18 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "A<content/>B",
        fallbackContent: "abc",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 19 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "A<content/>B",
        fallbackContent: null,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 20 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "A<content/>B",
        fallbackContent: undefined,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 21 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "No tags here",
        fallbackContent: "",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 22 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "No tags here",
        fallbackContent: "abc",
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> =
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 23 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "No tags here",
        fallbackContent: null,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });

    it("should test buildPromptContentHash( mock-parameters.promptFallbackContent 24 )", () => {
      const promptFallbackContent: Parameters<typeof buildPromptContentHash>[0] = {
        prompt: "No tags here",
        fallbackContent: undefined,
      };
      const __expectedResult: ReturnType<typeof buildPromptContentHash> = null;
      expect(buildPromptContentHash(promptFallbackContent)).toEqual(__expectedResult);
    });
  });

  describe("buildLengthKey", () => {
    const { buildLengthKey } = __testedFile;
    // lengthArg: LengthArg

    it("should test buildLengthKey( mock-parameters.lengthArg 1 )", () => {
      const lengthArg: Parameters<typeof buildLengthKey>[0] = { kind: "chars", maxCharacters: 10 };
      const __expectedResult: ReturnType<typeof buildLengthKey> = "chars:10";
      expect(buildLengthKey(lengthArg)).toEqual(__expectedResult);
    });

    it("should test buildLengthKey( mock-parameters.lengthArg 2 )", () => {
      const lengthArg: Parameters<typeof buildLengthKey>[0] = { kind: "preset", preset: "medium" };
      const __expectedResult: ReturnType<typeof buildLengthKey> = "preset:medium";
      expect(buildLengthKey(lengthArg)).toEqual(__expectedResult);
    });
  });

  describe("buildLanguageKey", () => {
    const { buildLanguageKey } = __testedFile;
    // outputLanguage: OutputLanguage

    it("should test buildLanguageKey( mock-parameters.outputLanguage 1 )", () => {
      const outputLanguage: Parameters<typeof buildLanguageKey>[0] = { kind: "auto" };
      const __expectedResult: ReturnType<typeof buildLanguageKey> = "auto";
      expect(buildLanguageKey(outputLanguage)).toEqual(__expectedResult);
    });

    it("should test buildLanguageKey( mock-parameters.outputLanguage 2 )", () => {
      const outputLanguage: Parameters<typeof buildLanguageKey>[0] = { kind: "fixed", tag: "TAG", label: "English" };
      const __expectedResult: ReturnType<typeof buildLanguageKey> = "TAG";
      expect(buildLanguageKey(outputLanguage)).toEqual(__expectedResult);
    });
  });

  describe("buildExtractCacheKeyValue", () => {
    const { buildExtractCacheKeyValue } = __testedFile;
    // cacheKey: { url: string; options: Record<string, unknown>; formatVersion: number; }

    it("should test buildExtractCacheKeyValue( mock-parameters.cacheKey 1 )", () => {
      const cacheKey: Parameters<typeof buildExtractCacheKeyValue>[0] = {
        url: "https://localhost",
        options: {},
        formatVersion: 1,
      };
      const __expectedResult: ReturnType<typeof buildExtractCacheKeyValue> =
        "0b8b6f834c5f41ded2d14c4aa6e3e57e836985335da96f6e6ceb4863b020b6e8";
      expect(buildExtractCacheKeyValue(cacheKey)).toEqual(__expectedResult);
    });
  });

  describe("buildSummaryCacheKeyValue", () => {
    const { buildSummaryCacheKeyValue } = __testedFile;
    // summaryCacheKey: { contentHash: string; promptHash: string; model: string; lengthKey: string; languageKey: string; formatVersion: number; }

    it("should test buildSummaryCacheKeyValue( mock-parameters.summaryCacheKey 1 )", () => {
      const summaryCacheKey: Parameters<typeof buildSummaryCacheKeyValue>[0] = {
        contentHash: "1",
        promptHash: "2",
        model: "model",
        lengthKey: "1",
        languageKey: "English",
        formatVersion: 1,
      };
      const __expectedResult: ReturnType<typeof buildSummaryCacheKeyValue> =
        "ab473a87b6e86f5630671862a4c4e933ca7a9f7dfdc6e8dde8e0c1692dd5ab64";
      expect(buildSummaryCacheKeyValue(summaryCacheKey)).toEqual(__expectedResult);
    });
  });

  describe("buildSlidesCacheKeyValue", () => {
    const { buildSlidesCacheKeyValue } = __testedFile;
    // slidesCacheKey: { url: string; settings: { ocr: boolean; outputDir: string; sceneThreshold: number; autoTuneThreshold: boolean; maxSlides: number; minDurationSeconds: number; }; formatVersion: number; }

    it("should test buildSlidesCacheKeyValue( mock-parameters.slidesCacheKey 1 )", () => {
      const slidesCacheKey: Parameters<typeof buildSlidesCacheKeyValue>[0] = {
        url: "url",
        settings: {
          ocr: true,
          outputDir: ".",
          sceneThreshold: 0,
          autoTuneThreshold: true,
          maxSlides: 1,
          minDurationSeconds: 1,
        },
        formatVersion: 1,
      };
      const __expectedResult: ReturnType<typeof buildSlidesCacheKeyValue> =
        "baa408bb0e376b3b2a100b575bfaf8bc26f539850cf3cf187ef810a95a40a600";
      expect(buildSlidesCacheKeyValue(slidesCacheKey)).toEqual(__expectedResult);
    });
  });

  describe("buildTranscriptCacheKeyValue", () => {
    const { buildTranscriptCacheKeyValue } = __testedFile;
    // transcriptCacheKey: { url: string; namespace: string; formatVersion: number; fileMtime?: number; }

    it("should test buildTranscriptCacheKeyValue( mock-parameters.transcriptCacheKey 1 )", () => {
      const transcriptCacheKey: Parameters<typeof buildTranscriptCacheKeyValue>[0] = {
        url: "url",
        namespace: "ns",
        formatVersion: 1,
        fileMtime: null,
      };
      const __expectedResult: ReturnType<typeof buildTranscriptCacheKeyValue> =
        "26243737dfcd6603f3823f35577d9a049ec328d3aaaf4349f67148f3bfc62332";
      expect(buildTranscriptCacheKeyValue(transcriptCacheKey)).toEqual(__expectedResult);
    });

    it("should test buildTranscriptCacheKeyValue( mock-parameters.transcriptCacheKey 2 )", () => {
      const transcriptCacheKey: Parameters<typeof buildTranscriptCacheKeyValue>[0] = {
        url: "url",
        namespace: "ns",
        formatVersion: 1,
        fileMtime: undefined,
      };
      const __expectedResult: ReturnType<typeof buildTranscriptCacheKeyValue> =
        "26243737dfcd6603f3823f35577d9a049ec328d3aaaf4349f67148f3bfc62332";
      expect(buildTranscriptCacheKeyValue(transcriptCacheKey)).toEqual(__expectedResult);
    });
  });
});

// 3TG (https://3tg.dev) created 70 tests in 2584 ms (36.914 ms per generated test) @ 2026-03-17T13:16:53.261Z
