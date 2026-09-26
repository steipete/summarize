import { availableUiLocales } from "@steipete/summarize-core/localization/messages";
import { Command, Option, type Argument } from "commander";
import {
  type CliLocale,
  type CliMessageKey,
  createCliTranslator,
  resolveCliLocaleFromEnv,
} from "../locale.js";
import {
  CLI_THEME_NAMES,
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
import { SUPPORT_URL } from "./constants.js";
import { supportsColor } from "./terminal.js";

const collectOption = (value: string, previous: string[] = []): string[] => [...previous, value];

export function buildProgram(locale: CliLocale = "en") {
  const t = createCliTranslator(locale);
  return new Command()
    .configureHelp(messageHelp(locale))
    .helpOption("-h, --help", t("help.display"))
    .name("summarize")
    .description(t("summarize.web.pages.and.youtube.links.uses.direct.provider.api.keys"))
    .argument("[input]", t("url.local.file.path.or.for.stdin.text.or.binary.to.summarize"))
    .option(
      "--youtube <mode>",
      t("youtube.transcript.source.auto.web.no.auto.skip.auto.generated.captions.yt.dlp.apify"),
      "auto",
    )
    .addOption(
      new Option(
        "--transcriber <name>",
        t(
          "local.transcription.stage.auto.default.whisper.parakeet.canary.groq.still.runs.first.when.keyed",
        ),
      ).choices(["auto", "whisper", "parakeet", "canary"]),
    )
    .addOption(
      new Option(
        "--diarize [provider]",
        t(
          "add.speaker.labels.to.youtube.or.direct.audio.video.auto.elevenlabs.then.openai.elevenlabs.openai",
        ),
      )
        .choices(["auto", "elevenlabs", "openai"])
        .preset("auto"),
    )
    .addOption(
      new Option(
        "--identify-speakers",
        t("resolve.diarization.labels.to.real.names.using.timestamp.anchors.and.openai.context"),
      ).default(undefined),
    )
    .addOption(
      new Option(
        "--no-identify-speakers",
        t("keep.generic.diarization.labels.even.when.speaker.identification.is.configured"),
      ).default(undefined),
    )
    .option(
      "--speaker-profile <name>",
      t("speaker.profile.from.summarize.config.json.implies.identify.speakers"),
    )
    .option(
      "--speaker-at <timestamp=name>",
      t("identify.the.speaker.active.at.a.timestamp.repeat.for.multiple.speakers"),
      collectOption,
      [],
    )
    .option(
      "--remember-speakers",
      t("persist.resolved.mappings.and.anchors.under.the.selected.speaker.profile"),
      false,
    )
    .addOption(
      new Option(
        "--video-mode <mode>",
        t("video.handling.auto.prefer.video.understanding.if.supported.transcript.understand"),
      )
        .choices(["auto", "transcript", "understand"])
        .default("auto"),
    )
    .addOption(
      new Option(
        "--embedded-video <mode>",
        t("embedded.youtube.handling.auto.off.prefer.transcript.or.combine.article.transcript"),
      )
        .choices(["auto", "off", "prefer", "both"])
        .default("auto"),
    )
    .option(
      "--slides [on|off]",
      t(
        "extract.slides.for.youtube.direct.video.urls.or.local.video.files.and.render.them.inline.inside.the.summary.narrative.when.supported.combine.with.extract.to.interleave.slides.in.the.full.transcript",
      ),
    )
    .option("--no-slides", t("disable.configured.slide.extraction.for.this.run"))
    .option("--slides-debug", t("show.slide.image.paths.instead.of.rendering.inline.images"), false)
    .option("--slides-ocr", t("run.ocr.on.extracted.slides.requires.tesseract"), false)
    .option("--no-slides-ocr", t("disable.configured.slide.ocr.for.this.run"))
    .option("--slides-dir <dir>", t("base.output.dir.for.slides.default.slides"), "slides")
    .option(
      "--slides-scene-threshold <value>",
      t("scene.detection.threshold.for.slide.changes.0.1.1.0"),
      "0.3",
    )
    .option("--slides-max <count>", t("maximum.slides.to.extract.default.6"), "6")
    .option("--slides-min-duration <seconds>", t("minimum.seconds.between.slides.default.2"), "2")
    .option("--timestamps", t("include.timestamps.in.transcripts.when.available"), false)
    .option(
      "--firecrawl <mode>",
      t("firecrawl.usage.off.auto.fallback.always.try.firecrawl.first"),
      "auto",
    )
    .option(
      "--format <format>",
      t(
        "website.file.content.format.md.text.for.websites.controls.the.extraction.format.for.files.controls.whether.we.try.to.preprocess.to.markdown.for.model.compatibility.default.text.default.in.extract.mode.for.urls.md",
      ),
      undefined,
    )
    .addOption(
      new Option(
        "--preprocess <mode>",
        t("preprocess.inputs.for.model.compatibility.off.auto.fallback.always"),
      )
        .choices(["off", "auto", "always"])
        .default("auto"),
    )
    .addOption(
      new Option(
        "--markdown-mode <mode>",
        t(
          "markdown.conversion.off.auto.llm.force.llm.readability.for.websites.converts.html.markdown.for.youtube.transcripts.llm.mode.formats.raw.transcripts.into.clean.markdown.with.headings.and.paragraphs",
        ),
      ).default("readability"),
    )
    .addOption(
      new Option(
        "--markdown <mode>",
        t("help.option.deprecated.alias.for.markdown.mode.use.extract.format.md.markdown.mode"),
      ).hideHelp(),
    )
    .option(
      "--length <length>",
      t(
        "summary.length.short.medium.long.xl.xxl.or.s.m.l.or.a.character.limit.like.20000.20k.default.long.configurable.via.summarize.config.json.output.length",
      ),
      "long",
    )
    .option(
      "--max-extract-characters <count>",
      t("maximum.characters.to.print.in.extract.default.unlimited"),
      undefined,
    )
    .option(
      "--language, --lang <language>",
      t(
        "output.language.auto.match.source.en.de.english.german.default.auto.configurable.in.summarize.config.json.via.output.language",
      ),
      undefined,
    )
    .option(
      "--locale <locale>",
      t("cli.interface.language.auto.en.or.tr.turkish.default.en.also.summarize.locale", {
        locales: new Intl.ListFormat(locale, { type: "disjunction" }).format([
          "auto",
          ...availableUiLocales,
        ]),
      }),
      undefined,
    )
    .option(
      "--max-output-tokens <count>",
      t("hard.cap.for.llm.output.tokens.e.g.2000.2k.overrides.provider.defaults"),
      undefined,
    )
    .option(
      "--force-summary",
      t("force.llm.summary.even.when.extracted.content.is.shorter.than.the.requested.length"),
      false,
    )
    .option(
      "--timeout <duration>",
      t("timeout.for.content.fetching.and.llm.request.30.seconds.30s.2m.5000ms"),
      "2m",
    )
    .option(
      "--retries <count>",
      t("llm.retry.attempts.after.timeouts.or.transient.api.failures.default.1"),
      "1",
    )
    .option(
      "--model <model>",
      t(
        "llm.model.id.auto.name.cli.provider.model.xai.openai.nvidia.minimax.google.anthropic.zai.or.openrouter.author.slug.default.auto",
      ),
      undefined,
    )
    .option(
      "--fast",
      t("use.the.openai.fast.service.tier.for.openai.models.sends.service.tier.priority"),
      false,
    )
    .addOption(
      new Option("--service-tier <tier>", t("openai.service.tier.default.fast.priority.flex"))
        .choices(["default", "fast", "priority", "flex"])
        .default(undefined),
    )
    .option(
      "--thinking <effort>",
      t("openai.reasoning.effort.none.low.medium.high.xhigh.aliases.off.min.mid"),
      undefined,
    )
    .option(
      "--prompt <text>",
      t("override.the.summary.prompt.instruction.prefix.context.content.still.appended"),
      undefined,
    )
    .option("--prompt-file <path>", t("read.the.prompt.override.from.a.file"), undefined)
    .option("--no-cache", t("bypass.summary.cache.llm.media.transcript.caches.stay.enabled"))
    .option("--no-media-cache", t("disable.media.download.cache.yt.dlp"))
    .option("--cache-stats", t("print.cache.stats.and.exit"))
    .option("--clear-cache", t("delete.the.cache.database.and.exit"), false)
    .addOption(
      new Option(
        "--cli [provider]",
        t(
          "use.a.cli.provider.claude.gemini.codex.agent.openclaw.opencode.copilot.agy.pi.equivalent.to.model.cli.provider.if.omitted.use.auto.selection.with.cli.enabled",
        ),
      ),
    )
    .option(
      "--extract",
      t("print.extracted.content.and.exit.urls.media.and.local.pdfs.stdin.is.unsupported"),
      false,
    )
    .addOption(
      new Option("--extract-only", t("help.option.deprecated.alias.for.extract")).hideHelp(),
    )
    .option("--json", t("output.structured.json.includes.prompt.metrics"), false)
    .option(
      "--stream <mode>",
      t("stream.llm.output.auto.tty.only.on.off.note.streaming.is.disabled.in.json.mode"),
      "auto",
    )
    .option(
      "--width <columns>",
      t("override.terminal.width.for.markdown.rendering.default.auto.detect.max.120"),
      undefined,
    )
    .option("--plain", t("keep.raw.text.markdown.output.no.ansi.osc.rendering"), false)
    .option("--no-color", t("disable.ansi.colors.in.output"), false)
    .addOption(
      new Option("--theme <name>", t("help.theme", { themes: CLI_THEME_NAMES.join(", ") })).choices(
        CLI_THEME_NAMES,
      ),
    )
    .option("--verbose", t("print.detailed.progress.info.to.stderr"), false)
    .option("--debug", t("alias.for.verbose.and.defaults.metrics.to.detailed"), false)
    .addOption(
      new Option("--metrics <mode>", t("metrics.output.off.on.detailed"))
        .choices(["off", "on", "detailed"])
        .default("on"),
    )
    .option("-V, --version", t("print.version.and.exit"), false)
    .allowExcessArguments(false);
}

export function applyHelpStyle(
  program: Command,
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream,
) {
  const color = supportsColor(stdout, env);
  const theme = createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: env.SUMMARIZE_THEME }),
    enabled: color,
    trueColor: resolveTrueColor(env),
  });
  program.configureHelp({
    ...program.configureHelp(),
    styleTitle: (text) => theme.heading(helpHeading(text, resolveCliLocaleFromEnv(env))),
    styleCommandText: (text) => theme.accentStrong(text),
    styleSubcommandText: (text) => theme.accent(text),
    styleOptionText: (text) => theme.label(text),
    styleArgumentText: (text) => theme.code(text),
    styleDescriptionText: (text) => theme.dim(text),
  });
}

export function buildSlidesProgram(locale: CliLocale = "en") {
  const t = createCliTranslator(locale);
  return new Command()
    .configureHelp(messageHelp(locale))
    .helpOption("-h, --help", t("help.display"))
    .name(/* i18n-ignore: Qualified CLI command name. */ "summarize slides")
    .description(
      t("extract.slide.screenshots.from.a.youtube.url.direct.video.url.or.local.video.file"),
    )
    .argument("<source>", t("youtube.url.direct.video.url.or.local.video.file"))
    .option("--slides-ocr", t("run.ocr.on.extracted.slides.requires.tesseract"), false)
    .option("--slides-dir <dir>", t("base.output.dir.for.slides.default.slides"), "slides")
    .option("-o, --output <dir>", t("alias.for.slides.dir"), undefined)
    .option(
      "--slides-scene-threshold <value>",
      t("scene.detection.threshold.for.slide.changes.0.1.1.0"),
      "0.3",
    )
    .option("--slides-max <count>", t("maximum.slides.to.extract.default.6"), "6")
    .option("--slides-min-duration <seconds>", t("minimum.seconds.between.slides.default.2"), "2")
    .addOption(
      new Option("--render <mode>", t("inline.render.mode.auto.kitty.iterm.none"))
        .choices(["auto", "kitty", "iterm", "none"])
        .default("none"),
    )
    .addOption(
      new Option("--theme <name>", t("help.theme", { themes: CLI_THEME_NAMES.join(", ") })).choices(
        CLI_THEME_NAMES,
      ),
    )
    .option("--timeout <duration>", t("timeout.for.video.download.extraction.default.2m"), "2m")
    .option("--no-cache", t("bypass.slide.cache.force.re.extract"))
    .option("--json", t("output.json.payload.no.inline.rendering"), false)
    .option("--verbose", t("print.detailed.progress.info.to.stderr"), false)
    .option("--debug", t("alias.for.verbose"), false)
    .option("-V, --version", t("print.version.and.exit"), false)
    .allowExcessArguments(false);
}

export function attachRichHelp(
  program: Command,
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream,
) {
  const t = createCliTranslator(resolveCliLocaleFromEnv(env));
  applyHelpStyle(program, env, stdout);
  const color = supportsColor(stdout, env);
  const theme = createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: env.SUMMARIZE_THEME }),
    enabled: color,
    trueColor: resolveTrueColor(env),
  });
  const heading = (text: string) => theme.heading(text);
  const cmd = (text: string) => theme.accentStrong(text);
  const dim = (text: string) => theme.dim(text);

  program.addHelpText(
    "after",
    () => `
${heading(t("examples"))}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com"')}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --extract')} ${dim(`# ${t("extracted.plain.text")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --extract --format md')} ${dim(`# ${t("extracted.markdown.prefers.firecrawl.when.configured")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --extract --format md --markdown-mode llm')} ${dim(`# ${t("extracted.markdown.via.llm")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://www.youtube.com/watch?v=..." --extract --format md --markdown-mode llm')} ${dim(`# ${t("transcript.as.formatted.markdown")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s" --extract --youtube web')}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://www.youtube.com/watch?v=..." --extract --diarize')} ${dim(`# ${t("speaker.labelled.transcript")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "./interview.mp3" --extract --diarize')} ${dim(`# ${t("diarize.a.local.recording")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://www.youtube.com/watch?v=..." --slides')} ${dim(`# ${t("summary.inline.slides")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://www.youtube.com/watch?v=..." --slides --slides-ocr')} ${dim(`# ${t("slides.ocr.extraction")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://www.youtube.com/watch?v=..." --slides --extract')} ${dim(`# ${t("full.transcript.inline.slides")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize slides "https://www.youtube.com/watch?v=..." --render auto')} ${dim(`# ${t("slides.only.mode.with.inline.thumbnails")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ "summarize transcriber setup")} ${dim(`# ${t("configure.local.onnx.transcription.parakeet.canary")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ "summarize status")} ${dim(`# ${t("show.configured.and.usable.model.providers")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --length 20k --max-output-tokens 2k --timeout 2m --model openai/gpt-5-mini')}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --model openai/gpt-5.5 --fast --thinking medium')}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --model openai/gpt-5.4 --service-tier fast --thinking low')}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --model mymodel')} ${dim(`# ${t("config.preset")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ 'summarize "https://example.com" --json --verbose')}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ "pbpaste | summarize -")} ${dim(`# ${t("summarize.clipboard.content")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ "summarize refresh-free")} ${dim(`# ${t("scan.update.working.openrouter.free.models")}`)}

${heading(t("env.vars"))}
${t("help.environment", { themes: CLI_THEME_NAMES.join(", ") })}

${heading(t("hint"))}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ "summarize refresh-free")} ${dim(`# ${t("refresh.free.model.candidates.into.summarize.config.json")}`)}
  ${cmd(/* i18n-ignore: Executable CLI example; descriptions use message keys. */ "summarize transcriber setup")} ${dim(`# ${t("show.local.onnx.setup.and.transcription.fallback.order")}`)}

${heading(t("support.alternate"))}
  ${SUPPORT_URL}
`,
  );
}

export function buildConciseHelp(locale: CliLocale = "en"): string {
  const t = createCliTranslator(locale);
  return [
    t("help.intro"),
    "",
    t("help.usage.summarize.input.flags"),
    "",
    t("help.examples"),
    '  summarize "https://example.com"',
    /* i18n-ignore: Executable CLI example. */ '  summarize "/path/to/file.pdf" --model google/gemini-3-flash',
    "  pbpaste | summarize -",
    "",
    t("run.summarize.help.for.full.options"),
    t("help.support", { url: SUPPORT_URL }),
  ].join("\n");
}

export function buildRefreshFreeHelp(locale: CliLocale = "en"): string {
  const t = createCliTranslator(locale);
  return [
    t(
      "help.usage.summarize.refresh.free.runs.2.smart.3.min.params.27b.max.age.days.180.set.default.verbose",
    ),
    "",
    t("writes.summarize.config.json.models.free.with.working.openrouter.free.candidates"),
    t("with.set.default.also.sets.model.to.free"),
  ].join("\n");
}

export function buildStatusHelp(locale: CliLocale = "en"): string {
  const t = createCliTranslator(locale);
  return [
    t("help.usage.summarize.status.json.probe.verbose"),
    "",
    t("shows.the.effective.model.configured.presets.and.configured.or.usable.providers"),
    t("missing.providers.are.omitted.secrets.are.never.printed"),
    "",
    t("options"),
    t("help.json.output.structured.json"),
    t("help.probe.probe.supported.model.list.endpoints.without.running.inference"),
    t("help.verbose.include.executable.paths.endpoint.hosts.config.sources.and.preset.candidates"),
  ].join("\n");
}

export function buildDaemonHelp(locale: CliLocale = "en"): string {
  const t = createCliTranslator(locale);
  return [
    t("help.usage.summarize.daemon.command.options"),
    "",
    t("commands"),
    t("help.install.install.upgrade.daemon.autostart.config.and.the.chrome.native.messaging.host"),
    t("help.restart.restart.the.daemon.autostart.service"),
    t("help.status.check.daemon.service.native.host.and.daemon.health"),
    t("help.uninstall.remove.daemon.autostart.and.the.chrome.native.messaging.host"),
    t("help.run.run.the.daemon.in.the.foreground.used.by.autostart"),
    "",
    t("notes"),
    t("help.macos.launchagent.launchd"),
    t("help.linux.systemd.user.service"),
    t("help.windows.scheduled.task"),
    t("help.chrome.native.host.macos.and.linux.windows.executable.packaging.pending"),
    "",
    t("options"),
    t("help.dev.install.service.that.runs.src.cli.ts.via.node.repo.dev.mode"),
    t("help.port.n.default.8787"),
    t("help.token.token.required.for.install"),
    t("help.extension.id.dev.only.unpacked.chrome.extension.id.requires.dev"),
    t("help.custom.ports.must.also.be.set.in.extension.options.runtime.daemon.port"),
  ].join("\n");
}

export function buildTranscriberHelp(locale: CliLocale = "en"): string {
  const t = createCliTranslator(locale);
  return [
    t("help.usage.summarize.transcriber.setup.model.parakeet.canary.theme.name"),
    "",
    t("configures.local.onnx.transcription.by.printing.the.required.env.vars"),
    t("help.transcriberOrder"),
    "",
    t("options"),
    t("help.model.name.parakeet.default.or.canary"),
    `  --theme <name>   ${CLI_THEME_NAMES.join(", ")}`,
    "",
    t("help.examples"),
    /* i18n-ignore: Executable CLI example. */ "  summarize transcriber setup",
    /* i18n-ignore: Executable CLI example. */ "  summarize transcriber setup --model canary",
  ].join("\n");
}

const HELP_HEADINGS: Readonly<Record<string, CliMessageKey>> = {
  "Usage:": "help.heading.usage",
  "Arguments:": "help.heading.arguments",
  "Options:": "help.heading.options",
  "Global Options:": "help.heading.globalOptions",
  "Commands:": "help.heading.commands",
};

function helpHeading(text: string, locale: CliLocale): string {
  return Object.hasOwn(HELP_HEADINGS, text)
    ? createCliTranslator(locale)(HELP_HEADINGS[text])
    : text;
}

function describeHelpItem(item: Option | Argument, locale: CliLocale): string {
  const t = createCliTranslator(locale);
  const extras: string[] = [];
  if (item.argChoices)
    extras.push(
      t("help.annotation.choices", {
        values: item.argChoices.map((choice) => JSON.stringify(choice)).join(", "),
      }),
    );
  const showDefault =
    !("isBoolean" in item) ||
    item.required ||
    item.optional ||
    (item.isBoolean() && typeof item.defaultValue === "boolean");
  if (item.defaultValue !== undefined && showDefault)
    extras.push(
      t("help.annotation.default", {
        value: item.defaultValueDescription || JSON.stringify(item.defaultValue),
      }),
    );
  if ("presetArg" in item && item.presetArg !== undefined && item.optional)
    extras.push(t("help.annotation.preset", { value: JSON.stringify(item.presetArg) }));
  if ("envVar" in item && item.envVar !== undefined)
    extras.push(t("help.annotation.env", { name: item.envVar }));
  if (!extras.length) return item.description;
  return t("help.annotation.description", {
    description: item.description,
    hasDescription: Boolean(item.description),
    details: new Intl.ListFormat(locale, { type: "unit", style: "short" }).format(extras),
  });
}

function messageHelp(locale: CliLocale) {
  return {
    styleTitle: (text: string) => helpHeading(text, locale),
    optionDescription: (option: Option) => describeHelpItem(option, locale),
    argumentDescription: (argument: Argument) => describeHelpItem(argument, locale),
  };
}
