# Exported functions from "src/cache-keys.ts"

<!--
```json configuration
{ "testing-framework": "vitest", "no-mock-imports": true }
```
-->

## hashString(strValue: string)

These are the functional requirements for function `hashString`.

| test name | strValue | hashString                                                         |
| --------- | -------- | ------------------------------------------------------------------ |
|           | ''       | 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' |
|           | 'abc'    | 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' |
|           | '😉'     | '62e785e976a0c101316f55c805ee6275ac3cb4eaae2f8e4f3d725c2bd1cfa52f' |

## hashJson(jsonValue: unknown)

These are the functional requirements for function `hashJson`.

| test name | jsonValue           | hashJson                                                                                                                 |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
|           | undefined           | throw 'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined' |
|           | null                | '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'                                                       |
|           | NaN                 | '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'                                                       |
|           | new Date('invalid') | '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b'                                                       |
|           | ()=>{}              | throw 'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined' |
|           | 0                   | '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9'                                                       |
|           | ''                  | '12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126'                                                       |
|           | {}                  | '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'                                                       |
|           | {valid:true}        | '8daf09a6fc31937457dd77e9c25ce4b21349d605b561a8c5d557841bf964c9a0'                                                       |

### Posible bug

1. The type of `jsonValue` should be reduced as not all types can be converted/preserved by JSON

## normalizeContentForHash(content: string)

These are the functional requirements for function `normalizeContentForHash`.

| test name | content               | normalizeContentForHash |
| --------- | --------------------- | ----------------------- |
|           | ''                    | ''                      |
|           | '\r\n'                | ''                      |
|           | ' \r\n '              | ''                      |
|           | ' \n '                | ''                      |
|           | 'abc'                 | 'abc'                   |
|           | '\r\nabc'             | 'abc'                   |
|           | 'abc\r\n'             | 'abc'                   |
|           | 'abc\r\n pqr \r\nxyz' | 'abc\n pqr \nxyz'       |

## extractTaggedBlock(propromptTextmpt: string, tag: "instructions" | "content")

These are the functional requirements for function `extractTaggedBlock`.

### Tests for tag "instructions"

| test name | promptText                                                                 | tag            | extractTaggedBlock |
| --------- | -------------------------------------------------------------------------- | -------------- | ------------------ |
|           | ''                                                                         | 'instructions' | null               |
|           | '<instructions/>'                                                          | 'instructions' | null               |
|           | '<instructions></instructions>'                                            | 'instructions' | ''                 |
|           | '<instructions>Do this</instructions>'                                     | 'instructions' | 'Do this'          |
|           | ' <instructions> Do this </instructions> '                                 | 'instructions' | 'Do this'          |
|           | '<instructions>Part 1\nPart 2</instructions>'                              | 'instructions' | 'Part 1\nPart 2'   |
|           | '<instructions>Do this</instructions><content>Text</content>'              | 'instructions' | 'Do this'          |
|           | '<instructions>Do this</instructions><instructions>Do that</instructions>' | 'instructions' | 'Do this'          |
|           | '<instructions>Do <tag/> this</instructions>'                              | 'instructions' | 'Do <tag/> this'   |

### Tests for tag "content"

We assume that actually `tag`'s value can be any string value.

### Possible bugs

1. `extractTaggedBlock` does not support nested tags of the some type.

| test name         | promptText                                                      | tag            | extractTaggedBlock |
| ----------------- | --------------------------------------------------------------- | -------------- | ------------------ |
| [bug] Nested Tags | '<instructions>A<instructions>B</instructions>C</instructions>' | 'instructions' | 'A<instructions>B' |

Note: This test is skipped.

## buildPromptHash(prompt: string)

These are the functional requirements for function `buildPromptHash`.

| test name | prompt                                     | buildPromptHash                                                    |
| --------- | ------------------------------------------ | ------------------------------------------------------------------ |
|           | ''                                         | 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' |
|           | 'abc'                                      | 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' |
|           | '<instructions>Do this</instructions>'     | '1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70' |
|           | '<instructions> Do this </instructions>'   | '1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70' |
|           | 'A <instructions>Do this</instructions> B' | '1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70' |
|           | 'Do this'                                  | '1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70' |
|           | ' Do this '                                | '1d75e222aec1fbd4e394723435858f4f40bab950a79ee6c3d5ae048ac77aec70' |

## buildPromptContentHash(promptFallbackContent: { prompt: string; fallbackContent?: string; })

These are the functional requirements for function `buildPromptContentHash`.

| test name | promptFallbackContent                                                                       | buildPromptContentHash                                             |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
|           | {prompt: '', fallbackContent: ''}                                                           | null                                                               |
|           | {prompt: '', fallbackContent: 'abc'}                                                        | 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' |
|           | {prompt: '', fallbackContent: null}                                                         | null                                                               |
|           | {prompt: '', fallbackContent: undefined}                                                    | null                                                               |
|           | {prompt: '<content></content>', fallbackContent: ''}                                        | null                                                               |
|           | {prompt: '<content></content>', fallbackContent: 'abc'}                                     | null                                                               |
|           | {prompt: '<content></content>', fallbackContent: null}                                      | null                                                               |
|           | {prompt: '<content></content>', fallbackContent: undefined}                                 | null                                                               |
|           | {prompt: '<content>Text</content>', fallbackContent: ''}                                    | '71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3' |
|           | {prompt: '<content>Text</content>', fallbackContent: 'abc'}                                 | '71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3' |
|           | {prompt: '<content>Text</content>', fallbackContent: null}                                  | '71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3' |
|           | {prompt: '<content>Text</content>', fallbackContent: undefined}                             | '71988c4d8e0803ba4519f0b2864c1331c14a1890bf8694e251379177bfedb5c3' |
|           | {prompt: '<instructions>A<content>B</content>C</instructions>', fallbackContent: ''}        | 'df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c' |
|           | {prompt: '<instructions>A<content>B</content>C</instructions>', fallbackContent: 'abc'}     | 'df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c' |
|           | {prompt: '<instructions>A<content>B</content>C</instructions>', fallbackContent: null}      | 'df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c' |
|           | {prompt: '<instructions>A<content>B</content>C</instructions>', fallbackContent: undefined} | 'df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c' |
|           | {prompt: 'A<content/>B', fallbackContent: ''}                                               | null                                                               |
|           | {prompt: 'A<content/>B', fallbackContent: 'abc'}                                            | 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' |
|           | {prompt: 'A<content/>B', fallbackContent: null}                                             | null                                                               |
|           | {prompt: 'A<content/>B', fallbackContent: undefined}                                        | null                                                               |
|           | {prompt: 'No tags here', fallbackContent: ''}                                               | null                                                               |
|           | {prompt: 'No tags here', fallbackContent: 'abc'}                                            | 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' |
|           | {prompt: 'No tags here', fallbackContent: null}                                             | null                                                               |
|           | {prompt: 'No tags here', fallbackContent: undefined}                                        | null                                                               |

## buildLengthKey(lengthArg: LengthArg)

These are the functional requirements for function `buildLengthKey`.

| test name | lengthArg                         | buildLengthKey  |
| --------- | --------------------------------- | --------------- |
|           | { kind:'preset', preset:'medium'} | 'preset:medium' |
|           | { kind:'chars', maxCharacters:10} | 'chars:10'      |

## buildLanguageKey(outputLanguage: OutputLanguage)

These are the functional requirements for function `buildLanguageKey`.

| test name | outputLanguage                             | buildLanguageKey |
| --------- | ------------------------------------------ | ---------------- |
|           | {kind:'auto'}                              | 'auto'           |
|           | {kind:'fixed', tag:'TAG', label:'English'} | 'TAG'            |

## buildExtractCacheKeyValue(cacheKey: { url: string; options: Record<string, unknown>; formatVersion: number; })

These are the functional requirements for function `buildExtractCacheKeyValue`.

| test name | cacheKey                                               | buildExtractCacheKeyValue                                          |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
|           | {url:'https://localhost', options:{}, formatVersion:1} | '0b8b6f834c5f41ded2d14c4aa6e3e57e836985335da96f6e6ceb4863b020b6e8' |

Note: It can be replaced with or made an alias of `hashJson`. `hashJson` should be made generic.

## buildSummaryCacheKeyValue(summaryCacheKey: { contentHash: string; promptHash: string; model: string; lengthKey: string; languageKey: string; formatVersion: number; })

These are the functional requirements for function `buildSummaryCacheKeyValue`.

| test name | summaryCacheKey                                                                                         | buildSummaryCacheKeyValue                                          |
| --------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
|           | {contentHash:'1', promptHash:'2', model:'model', lengthKey:'1', languageKey:'English', formatVersion:1} | 'ab473a87b6e86f5630671862a4c4e933ca7a9f7dfdc6e8dde8e0c1692dd5ab64' |

Note: It can be replaced with or made an alias of `hashJson`. `hashJson` should be made generic.

## buildSlidesCacheKeyValue(slidesCacheKey: { url: string; settings: { ocr: boolean; outputDir: string; sceneThreshold: number; autoTuneThreshold: boolean; maxSlides: number; minDurationSeconds: number; }; formatVersion: number; })

These are the functional requirements for function `buildSlidesCacheKeyValue`.

| test name | slidesCacheKey                                                                                                                                | buildSlidesCacheKeyValue                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
|           | {url:'url', settings:{ocr:true, outputDir:'.', sceneThreshold:0, autoTuneThreshold:true, maxSlides:1, minDurationSeconds:1}, formatVersion:1} | 'baa408bb0e376b3b2a100b575bfaf8bc26f539850cf3cf187ef810a95a40a600' |

Note: It can be replaced with or made an alias of `hashJson`. `hashJson` should be made generic.

## buildTranscriptCacheKeyValue(transcriptCacheKey: { url: string; namespace: string|null; formatVersion: number; fileMtime?: number|null; })

These are the functional requirements for function `buildTranscriptCacheKeyValue`.

| test name | transcriptCacheKey                                                | buildTranscriptCacheKeyValue                                       |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
|           | {url:'url', namespace:'ns', formatVersion:1, fileMtime:null}      | '26243737dfcd6603f3823f35577d9a049ec328d3aaaf4349f67148f3bfc62332' |
|           | {url:'url', namespace:'ns', formatVersion:1, fileMtime:undefined} | '26243737dfcd6603f3823f35577d9a049ec328d3aaaf4349f67148f3bfc62332' |

Note: It can be replaced with or made an alias of `hashJson`. `hashJson` should be made generic.
