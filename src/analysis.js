const asSkillRoles = [
  "analysis",
  "bible",
  "direction",
  "cinematography",
  "editing",
  "sound",
  "prompt-image",
  "prompt-video",
  "continuity",
];
function asRoles(skill) {
  return Array.isArray(skill.roles)
    ? skill.roles
    : {
        direction: ["direction", "analysis", "bible", "continuity"],
        cinematography: ["cinematography", "prompt-image", "prompt-video"],
        editing: ["editing"],
        color: ["cinematography", "prompt-image"],
        sound: ["sound"],
        custom: ["analysis"],
      }[skill.type] || ["analysis"];
}
function asPassSkills(project, roles) {
  return project.meta.skillIds
    .map((id) => project.skills.find((s) => s.id === id))
    .filter(Boolean)
    .filter((s) => asRoles(s).some((r) => roles.includes(r)));
}
function asPassSchema(pass) {
  const names = Cc(U()),
    dialogue = Cc(wc({ character: U(), line: U(), lang: Tc(["en", "te"]) }));
  if (pass === 1)
    return wc({
      summary: U(),
      location: U(),
      time: U(),
      characters: names,
      props: names,
      costumes: names,
      mood: U(),
      beats: names,
      continuity: names,
    });
  if (pass === 2) {
    const assets = Cc(wc({ name: U(), description: U(), prompt: U() }));
    return wc({
      characters: assets,
      environments: assets,
      props: assets,
      costumes: assets,
      vision: U(),
      style: U(),
    });
  }
  if (pass === 3)
    return wc({
      shots: Cc(
        wc({
          action: U(),
          type: U(),
          angle: U(),
          movement: U(),
          lens: U(),
          duration: xc().positive(),
          characters: names,
          environment: U(),
          dialogue,
          soundCue: U(),
        }),
      ).min(1),
    });
  return wc({
    imagePrompt: U().min(1),
    videoPrompt: U().min(1),
    negativePrompt: U(),
    references: names,
  });
}
function asPassJSONSchema(pass) {
  const string = { type: "string" },
    names = { type: "array", items: string },
    obj = (properties) => ({
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    }),
    assets = {
      type: "array",
      items: obj({ name: string, description: string, prompt: string }),
    };
  if (pass === 1)
    return obj({
      summary: string,
      location: string,
      time: string,
      characters: names,
      props: names,
      costumes: names,
      mood: string,
      beats: names,
      continuity: names,
    });
  if (pass === 2)
    return obj({
      characters: assets,
      environments: assets,
      props: assets,
      costumes: assets,
      vision: string,
      style: string,
    });
  if (pass === 3)
    return obj({
      shots: {
        type: "array",
        items: obj({
          action: string,
          type: string,
          angle: string,
          movement: string,
          lens: string,
          duration: { type: "number", exclusiveMinimum: 0 },
          characters: names,
          environment: string,
          dialogue: {
            type: "array",
            items: obj({
              character: string,
              line: string,
              lang: { type: "string", enum: ["en", "te"] },
            }),
          },
          soundCue: string,
        }),
      },
    });
  return obj({
    imagePrompt: string,
    videoPrompt: string,
    negativePrompt: string,
    references: names,
  });
}
function asPassBudget(project, profile, pass, input) {
  const roles = {
      1: ["analysis"],
      2: ["bible", "direction", "cinematography"],
      3: ["direction", "cinematography", "editing", "sound", "continuity"],
      4: ["prompt-image", "prompt-video"],
    }[pass],
    skills = asPassSkills(project, roles),
    cuts = [],
    context = {
      title: project.meta.title,
      genres: project.meta.genres,
      aspect: project.meta.aspectRatio,
      styles: [project.meta.directingStyle, project.meta.cinematographyStyle],
      glossary: project.meta.glossary,
      stylePrefix: project.meta.stylePrefix,
      styleSuffix: pass === 4 ? project.meta.styleSuffix : undefined,
    };
  const base =
    "You are ASTRA. Return only the requested small JSON object; never return a whole project. Preserve Telugu/English verbatim. Pass " +
    pass +
    ". " +
    {
      1: "Analyze this scene window only.",
      2: "Deduplicate the supplied scene analyses into a compact bible; no screenplay is supplied.",
      3: "Design ordered shots. Every input dialogue line must occur exactly once. Respect maxClipLength.",
      4: "Write image/video prompts using supplied identities and references.",
    }[pass];
  const output = profile.maxOutputTokens;
  let system;
  for (;;) {
    system =
      base +
      "\nProject context:" +
      JSON.stringify(context) +
      "\nSkills in priority order:\n" +
      skills.map((s) => s.name + "\n" + s.body).join("\n");
    const estimate = asEstimateTokens(system + JSON.stringify(input), profile);
    if (estimate + output <= profile.contextWindow) break;
    if (!skills.length)
      throw Error(
        "Pass " +
          pass +
          " exceeds context (" +
          (estimate + output) +
          "/" +
          profile.contextWindow +
          "). Use a smaller scene window or larger context. No input was silently cut.",
      );
    cuts.push("Dropped lowest-priority skill: " + skills.pop().name);
  }
  return {
    system,
    input: JSON.stringify(input),
    cuts,
    budget: {
      system: asEstimateTokens(base + JSON.stringify(context), profile),
      skills: asEstimateTokens(skills.map((s) => s.body).join(""), profile),
      input: asEstimateTokens(JSON.stringify(input), profile),
      output,
      context: profile.contextWindow,
    },
  };
}
function asSceneWindows(scene, profile) {
  const limit = Math.max(
      256,
      Math.floor(
        (profile.contextWindow - profile.maxOutputTokens - 1800) * 0.55,
      ),
    ),
    parts = [];
  let text = "";
  for (const line of scene.text.split("\n")) {
    if (asEstimateTokens(line, profile) > limit)
      throw Error(
        "A single screenplay line exceeds the scene-window budget. Increase context or split that line manually.",
      );
    if (text && asEstimateTokens(text + "\n" + line, profile) > limit) {
      parts.push(text);
      text = "";
    }
    text += (text ? "\n" : "") + line;
  }
  if (text) parts.push(text);
  return parts.length ? parts : [""];
}
async function asAnalysisPass(
  project,
  profile,
  pass,
  input,
  key,
  simulate,
  signal,
  onStatus,
) {
  const fingerprint = await asFingerprint({
      pass,
      input,
      profile: {
        id: profile.id,
        model: profile.model,
        context: profile.contextWindow,
        max: profile.maxOutputTokens,
      },
      skills: asPassSkills(
        project,
        {
          1: ["analysis"],
          2: ["bible", "direction", "cinematography"],
          3: ["direction", "cinematography", "editing", "sound", "continuity"],
          4: ["prompt-image", "prompt-video"],
        }[pass],
      ),
    }),
    storageKey = "astra-analysis:" + Kl.getState().activeId + ":" + key,
    prior = await Wo(storageKey);
  if (prior?.fingerprint === fingerprint && prior.result) {
    asPassSchema(pass).parse(prior.result);
    return prior.result;
  }
  if (
    asPipelineRuntime.onlyPass !== undefined &&
    pass < asPipelineRuntime.onlyPass
  )
    throw Error(
      "Required pass " +
        pass +
        " checkpoint is missing or stale. Run that pass first.",
    );
  const request = asPassBudget(project, profile, pass, input);
  asPipelineRuntime.preview = { pass, key, ...request };
  asPipelineNotify();
  for (const cut of request.cuts)
    await asRunLog("analysis", "budget-cut", { pass, key, cut });
  let output = "",
    errorText = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    onStatus?.(
      "Pass " + pass + " " + key + (attempt ? " repair " + attempt : ""),
    );
    const repair = attempt
      ? "\nValidation errors:" +
        errorText +
        "\nRepair only this item; return the same schema. Prior response:" +
        output
      : "";
    if (
      asEstimateTokens(request.system + request.input + repair, profile) +
        profile.maxOutputTokens >
      profile.contextWindow
    )
      throw Error(
        "Repair does not fit context; raise the profile context or reduce this item. Checkpoint retained.",
      );
    output = await asLLMRequest(
      profile,
      request.system,
      request.input + repair,
      {
        signal,
        schema: asPassJSONSchema(pass),
        name: "astra_pass_" + pass,
        simulate,
      },
    );
    if (
      asPipelineRuntime.analysisOrigin &&
      (G.getState().project.script !==
        asPipelineRuntime.analysisOrigin.script ||
        JSON.stringify(G.getState().project.meta) !==
          JSON.stringify(asPipelineRuntime.analysisOrigin.meta) ||
        JSON.stringify(G.getState().project.shots.map(asTargetRevision)) !==
          JSON.stringify(
            asPipelineRuntime.analysisOrigin.shots.map(asTargetRevision),
          ))
    )
      throw Error(
        "Project changed during analysis. Run Analyze again to include your latest edits.",
      );
    try {
      const result = asPassSchema(pass).parse(asJSONExtract(output));
      if (pass === 3) {
        if (result.shots.some((s) => s.duration > Number(input.maxClipLength)))
          throw Error(
            "A shot exceeds the model maximum clip length " +
              input.maxClipLength,
          );
        const counts = (values) => {
          const map = {};
          for (const line of values) {
            const key = line.character + "\0" + line.line + "\0" + line.lang;
            map[key] = (map[key] || 0) + 1;
          }
          return JSON.stringify(Object.entries(map).sort());
        };
        if (
          counts(input.dialogue || []) !==
          counts(result.shots.flatMap((s) => s.dialogue))
        )
          throw Error(
            "Every supplied dialogue line must occur exactly once, unchanged, with its speaker and language; remove invented lines.",
          );
      }

      await Go(storageKey, { fingerprint, result, completedAt: Date.now() });
      await asRunLog("analysis", "checkpoint", { pass, key });
      if (asPipelineRuntime.stopAfter && asPipelineRuntime.active) {
        asPipelineRuntime.controller.abort(
          new DOMException("Stopped after current analysis item", "AbortError"),
        );
        asPipelineRuntime.controller.signal.throwIfAborted();
      }
      return result;
    } catch (e) {
      errorText = e.message;
      if (attempt === 2)
        throw Error(
          "Pass " +
            pass +
            " " +
            key +
            " failed validation after two repairs: " +
            errorText,
        );
    }
  }
}
function asAnalysisValidate(candidate) {
  const errors = [...mv(candidate).errors];
  for (const scene of candidate.scenes) {
    const expected = asAnalysisDialogue(scene, candidate).map(
      (l) => l.character + "\0" + l.line,
    );
    const actual = candidate.shots
      .filter((s) => s.sceneId === scene.id)
      .flatMap((s) => s.dialogue)
      .map((l) => l.character + "\0" + l.line);
    const counts = (a) =>
      a.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
    const a = counts(expected),
      b = counts(actual);
    for (const [line, count] of a)
      if (b.get(line) !== count)
        errors.push(
          scene.id +
            ": dialogue coverage differs for " +
            line.replace("\0", ": "),
        );
    for (const [line] of b)
      if (!a.has(line))
        errors.push(
          scene.id + ": invented dialogue " + line.replace("\0", ": "),
        );
  }
  for (const shot of candidate.shots)
    if (!shot.imagePrompt?.trim() || !shot.videoPrompt?.trim())
      errors.push(shot.id + ": prompts are empty");
  return errors;
}
async function asAnalysisRun(
  project,
  { profile, signal, onStatus, sceneIds = [], passOnly, offline = false } = {},
) {
  if (offline || passOnly === 0) {
    const candidate = await asAnalysisSeed(project);
    await asAnalysisCheckpoint(project, candidate, [], {
      offline: true,
      pass: 0,
    });
    return candidate;
  }
  profile =
    profile || K.getState().llm.find((p) => p.id === K.getState().activeLlmId);
  if (!profile) {
    if (!offline)
      throw Error(
        "No active LLM. Choose an LLM profile or explicitly choose Offline parser.",
      );
    const candidate = sl(project);
    await asAnalysisCheckpoint(project, candidate, [], { offline: true });
    return candidate;
  }
  profile = asLLMProfile(profile);
  asPipelineRuntime.analysisOrigin =
    G.getState().project === project ? project : null;
  asPipelineRuntime.onlyPass = passOnly;
  if (passOnly === 0) {
    const candidate = await asAnalysisSeed(project);
    await asAnalysisCheckpoint(project, candidate, [], {
      offline: true,
      pass: 0,
    });
    return candidate;
  }
  const parsed = await asAnalysisSeed(project),
    scenes = parsed.scenes.filter(
      (s) => !sceneIds.length || sceneIds.includes(s.id),
    ),
    summaries = [];
  await asHardwareToLLM(profile, signal);
  let primaryError;
  try {
    for (const scene of scenes) {
      signal?.throwIfAborted();
      const windows = asSceneWindows(scene, profile),
        pieces = [];
      for (let i = 0; i < windows.length; i++)
        pieces.push(
          await asAnalysisPass(
            project,
            profile,
            1,
            {
              scene: { id: scene.id, slug: scene.slug, text: windows[i] },
              window: i + 1,
              windows: windows.length,
            },
            "scene:" + scene.id + ":" + i,
            () => ({
              summary: scene.summary || scene.slug,
              location: scene.location || scene.slug,
              time: scene.time || "DAY",
              characters: asAnalysisDialogue(scene, project)
                .filter((l) => windows[i].includes(l.line))
                .map((l) => l.character),
              props: [],
              costumes: [],
              mood: scene.mood || "",
              beats: [],
              continuity: [],
            }),
            signal,
            onStatus,
          ),
        );
      summaries.push({
        sceneId: scene.id,
        ...pieces[0],
        summary: pieces.map((p) => p.summary).join("\n"),
        characters: [...new Set(pieces.flatMap((p) => p.characters))],
        props: [...new Set(pieces.flatMap((p) => p.props))],
        costumes: [...new Set(pieces.flatMap((p) => p.costumes))],
      });
    }
    if (passOnly === 1) {
      await asRunLog("analysis", "pass-review", {
        pass: 1,
        scenes: summaries.length,
      });
      asPipelineRuntime.passResults = summaries;
      asPipelineNotify();
      return project;
    }
    const bibleInput = summaries.map((s) => ({
      ...s,
      summary: s.summary.slice(0, 240),
    }));
    if (summaries.some((s) => s.summary.length > 240))
      await asRunLog("analysis", "budget-cut", {
        cut: "Bible input uses first 240 characters of each scene summary; full pass checkpoints retained.",
      });
    const bible = await asAnalysisPass(
      project,
      profile,
      2,
      { scenes: bibleInput },
      "bible",
      () => ({
        characters: [...new Set(summaries.flatMap((s) => s.characters))].map(
          (name) => ({ name, description: name, prompt: name }),
        ),
        environments: [...new Set(summaries.map((s) => s.location))].map(
          (name) => ({ name, description: name, prompt: name }),
        ),
        props: [],
        costumes: [],
        vision: project.vision?.statement || "Story-driven local production",
        style:
          project.lookBible?.styleBlock ||
          project.meta.stylePrefix ||
          "Naturalistic",
      }),
      signal,
      onStatus,
    );
    if (passOnly === 2) {
      asPipelineRuntime.passResults = bible;
      asPipelineNotify();
      return project;
    }
    let candidate = {
      ...parsed,
      scenes: parsed.scenes.map((scene) => {
        const result = summaries.find((r) => r.sceneId === scene.id);
        return result
          ? {
              ...scene,
              summary: result.summary,
              location: result.location,
              time: result.time,
              mood: result.mood,
              productionNotes:
                scene.productionNotes || result.continuity.join("\n"),
            }
          : scene;
      }),
      vision: { ...parsed.vision, statement: bible.vision },
      lookBible: { ...parsed.lookBible, styleBlock: bible.style },
    };
    for (const [kind, schema] of [
      ["characters", Nc],
      ["environments", Fc],
      ["props", Ic],
      ["costumes", Lc],
    ]) {
      const records = [...candidate[kind]];
      for (const asset of bible[kind])
        if (!records.some((a) => a.name === asset.name))
          records.push(
            schema.parse({
              ...asset,
              id:
                "ai_" + kind + "_" + asDeliverySlug(asset.name, records.length),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }),
          );
      candidate[kind] = records.map((asset) => ({
        ...asset,
        sceneIds: [
          ...new Set([
            ...asset.sceneIds,
            ...summaries
              .filter((r) =>
                kind === "characters"
                  ? r.characters.includes(asset.name)
                  : kind === "environments"
                    ? r.location === asset.name
                    : r[kind]?.includes(asset.name),
              )
              .map((r) => r.sceneId),
          ]),
        ],
      }));
    }
    for (const scene of scenes) {
      const current = candidate.shots.filter((s) => s.sceneId === scene.id),
        windows = asSceneWindows(scene, profile);
      let designed = [];
      for (let wi = 0; wi < windows.length; wi++) {
        const dialogue = asAnalysisDialogue(scene, project)
          .filter((l) => windows[wi].includes(l.line))
          .map((l) => ({
            character: l.character,
            line: l.line,
            lang: /[\u0c00-\u0c7f]/.test(l.line) ? "te" : "en",
          }));
        const result = await asAnalysisPass(
          project,
          profile,
          3,
          {
            scene: { id: scene.id, slug: scene.slug, text: windows[wi] },
            bible: {
              characters: candidate.characters.map((c) => c.name),
              environments: candidate.environments.map((e) => e.name),
            },
            maxClipLength:
              Number(
                project.modelProfiles.find(
                  (m) => m.id === asProduction(project).settings.modelProfileId,
                )?.parameters?.maxClipLength,
              ) || 8,
            dialogue,
          },
          "shots:" + scene.id + ":" + wi,
          () => ({
            shots: [
              {
                action: scene.summary || scene.slug,
                type: "MS",
                angle: "Eye level",
                movement: "Static",
                lens: "35mm",
                duration: 3,
                characters: dialogue.map((l) => l.character),
                environment: scene.location || scene.slug,
                dialogue,
                soundCue: "",
              },
            ],
          }),
          signal,
          onStatus,
        );
        designed.push(...result.shots);
      }
      const shots = [];
      for (const [i, data] of designed.entries()) {
        const existing = current[i],
          shot = Bc.parse({
            ...data,
            id: existing?.id || "ai_shot_" + scene.id + "_" + (i + 1),
            sceneId: scene.id,
            order: (i + 1) * 10,
            characterIds: data.characters
              .map(
                (name) => candidate.characters.find((c) => c.name === name)?.id,
              )
              .filter(Boolean),
            environmentId:
              candidate.environments.find((e) => e.name === data.environment)
                ?.id || "",
            propIds: (
              summaries.find((r) => r.sceneId === scene.id)?.props || []
            )
              .map((name) => candidate.props.find((a) => a.name === name)?.id)
              .filter(Boolean),
            costumeIds: (
              summaries.find((r) => r.sceneId === scene.id)?.costumes || []
            )
              .map(
                (name) => candidate.costumes.find((a) => a.name === name)?.id,
              )
              .filter(Boolean),
            dialogue: data.dialogue,
          });
        const prompts =
          passOnly === 3
            ? {
                imagePrompt: existing?.imagePrompt || "",
                videoPrompt: existing?.videoPrompt || "",
                negativePrompt: existing?.negativePrompt || "",
              }
            : await asAnalysisPass(
                project,
                profile,
                4,
                {
                  shot: {
                    id: shot.id,
                    action: shot.action,
                    type: shot.type,
                    angle: shot.angle,
                    movement: shot.movement,
                    duration: shot.duration,
                    dialogue: shot.dialogue,
                  },
                  identities: shot.characterIds
                    .map((id) => candidate.characters.find((c) => c.id === id))
                    .map((c) => ({
                      name: c.name,
                      prompt: c.prompt,
                      idBlock: c.idBlock,
                    })),
                  references: il(candidate, shot).map(
                    (url, i) => "ref_image_" + (i + 1),
                  ),
                  style: project.meta.stylePrefix,
                },
                "prompts:" + shot.id,
                () => ({
                  imagePrompt:
                    "SIMULATION — " +
                    shot.action +
                    ", " +
                    shot.type +
                    ", " +
                    project.meta.stylePrefix,
                  videoPrompt:
                    "SIMULATION — " + shot.action + ", continuous motion",
                  negativePrompt: "artifacts, watermark",
                  references: [],
                }),
                signal,
                onStatus,
              );
        shots.push({
          ...shot,
          ...prompts,
          image: existing?.image || shot.image,
          video: existing?.video || shot.video,
        });
      }
      candidate.shots = [
        ...candidate.shots.filter((s) => s.sceneId !== scene.id),
        ...shots,
      ];
    }
    candidate = Uc.parse(candidate);
    candidate = asAnalysisMerge(
      project,
      asSyncScriptNumbers(project, candidate),
    );
    const errors = asAnalysisValidate(candidate);
    await asAnalysisCheckpoint(project, candidate, errors, {
      profileId: profile.id,
    });
    return candidate;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    asPipelineRuntime.analysisOrigin = null;
    asPipelineRuntime.onlyPass = undefined;
    await asHardwareToComfy(
      profile,
      signal?.aborted ? undefined : signal,
    ).catch(async (e) => {
      await asRunLog("handoff", "failed", { reason: e.message });
      if (!primaryError) throw e;
    });
  }
}
async function asAnalysisCheckpoint(original, candidate, errors, metadata) {
  const key = "astra-analysis-review:" + Kl.getState().activeId;
  await Go(key, {
    scriptHash: await asFingerprint(original.script),
    candidate: await asMediaPack(candidate),
    errors,
    ...metadata,
    createdAt: Date.now(),
  });
  asPipelineRuntime.reviewProjectId = Kl.getState().activeId;
  asPipelineRuntime.reviewAvailable = true;
  asPipelineRuntime.review = {
    candidate,
    errors,
    scriptHash: await asFingerprint(original.script),
    ...metadata,
  };
  asPipelineNotify();
}
async function asAnalysisAccept(sceneIds) {
  const review =
    asPipelineRuntime.review ||
    (await Wo("astra-analysis-review:" + Kl.getState().activeId));
  if (!review) throw Error("No analysis checkpoint to review");
  if (review.errors?.length)
    throw Error(
      "Analysis has unresolved validation errors. Edit/fix the proposal or rerun the failing scene before accepting: " +
        review.errors.slice(0, 5).join("; "),
    );
  if (
    review.scriptHash &&
    review.scriptHash !== (await asFingerprint(G.getState().project.script))
  )
    throw Error(
      "Screenplay changed since analysis. Rerun affected passes before accepting.",
    );
  const current = G.getState().project;
  let candidate = await asMediaHydrate(review.candidate);
  if (sceneIds?.length)
    candidate = {
      ...current,
      ...Object.fromEntries(
        ["characters", "environments", "props", "costumes"].map((k) => [
          k,
          candidate[k],
        ]),
      ),
      scenes: current.scenes.map((s) =>
        sceneIds.includes(s.id)
          ? candidate.scenes.find((v) => v.id === s.id) || s
          : s,
      ),
      shots: [
        ...current.shots.filter((s) => !sceneIds.includes(s.sceneId)),
        ...candidate.shots.filter((s) => sceneIds.includes(s.sceneId)),
      ],
    };
  candidate = {
    ...asAnalysisMerge(current, candidate),
    pipeline: current.pipeline,
    production: current.production,
  };
  for (const shot of current.shots)
    if (
      shot.lockedFields?.includes("*") ||
      asProduction(current).shots[shot.id]?.userEdited
    )
      candidate.shots = candidate.shots.map((s) =>
        s.id === shot.id ? shot : s,
      );
  for (const kind of ["characters", "environments", "props", "costumes"])
    candidate[kind] = candidate[kind].map((asset) =>
      asPipelineData(current).manualAssets?.includes(asset.id)
        ? current[kind].find((a) => a.id === asset.id) || asset
        : asset,
    );
  asPipelineRuntime.applying = true;
  try {
    G.getState().replace(
      Uc.parse(candidate),
      "Before multi-pass analysis merge",
    );
    await Ul();
    await asPipelineSave((d) => ({
      ...d,
      analysisScriptHash:
        asPipelineRuntime.review?.scriptHash || review.scriptHash,
      analysisAcceptedAt: Date.now(),
    }));
  } finally {
    asPipelineRuntime.applying = false;
  }
  if (!asPipelineRuntime.active)
    await asPipelineStage(0, {
      status: "done",
      lastRun: Date.now(),
      fingerprint: await asStageFingerprint(0),
      stale: false,
    });
  return candidate;
}
async function asAnalysisSeed(project) {
  const seed = sl(project),
    ids = new Map();
  for (const [i, scene] of seed.scenes.entries()) {
    if (project.scenes.some((s) => s.id === scene.id)) continue;
    const id =
      "scene_" +
      (
        await asFingerprint({
          number: i + 1,
          slug: scene.slug,
          scriptNumber: scene.scriptNumber,
        })
      ).slice(0, 18);
    ids.set(scene.id, id);
    scene.id = id;
  }
  for (const shot of seed.shots) {
    if (ids.has(shot.sceneId)) {
      shot.sceneId = ids.get(shot.sceneId);
      shot.id = "shot_" + shot.sceneId + "_" + shot.order;
    }
  }
  for (const kind of ["characters", "environments", "props", "costumes"])
    for (const asset of seed[kind]) {
      asset.sceneIds = asset.sceneIds.map((id) => ids.get(id) || id);
      if (!project[kind].some((a) => a.id === asset.id)) {
        const old = asset.id;
        asset.id = kind + "_" + (await asFingerprint(asset.name)).slice(0, 18);
        for (const shot of seed.shots) {
          if (kind === "environments" && shot.environmentId === old)
            shot.environmentId = asset.id;
          const key = {
            characters: "characterIds",
            props: "propIds",
            costumes: "costumeIds",
          }[kind];
          if (key)
            shot[key] = shot[key].map((id) => (id === old ? asset.id : id));
        }
      }
    }
  return seed;
}

function asAnalysisDialogue(scene, project) {
  const parsed = tl(project.script, asProjectElements(project));
  const item =
    parsed.find(
      (s) => s.scriptNumber && s.scriptNumber === scene.scriptNumber,
    ) ||
    parsed[(scene.number || 1) - 1] ||
    parsed.find((s) => s.slug === scene.slug);
  return (item?.dialogue || []).map(({ character, line }) => ({
    character,
    line,
    lang: /[\u0c00-\u0c7f]/.test(line) ? "te" : "en",
  }));
}

function asAnalysisMerge(original, incoming) {
  const merged = asAlignScriptProject(asMergeAnalysis(original, incoming)),
    incomingIds = new Map(incoming.shots.map((s) => [s.id, s])),
    protectedShot = (s) =>
      s.image.versions.length ||
      s.video.versions.length ||
      s.lockedFields?.length ||
      asProduction(original).shots[s.id]?.userEdited ||
      s.imagePrompt ||
      s.videoPrompt ||
      s.updatedAt > s.createdAt ||
      (!s.id.startsWith("shot_scene_") &&
        !qc.shots.some(
          (v) => v.id === s.id && asTargetRevision(v) === asTargetRevision(s),
        ));
  merged.shots = merged.shots
    .filter((s) => incomingIds.has(s.id) || protectedShot(s))
    .map((s) => {
      const next = incomingIds.get(s.id),
        old = original.shots.find((v) => v.id === s.id);
      return next && (!old || !protectedShot(old)) ? next : s;
    });
  const knownScenes = new Set(
    [...merged.scenes, ...(merged.archivedScenes || [])].map((s) => s.id),
  );
  for (const kind of ["characters", "environments", "props", "costumes"])
    merged[kind] = merged[kind].map((asset) => {
      const missing = asset.sceneIds.filter((id) => !knownScenes.has(id));
      if (missing.length)
        asPipelineRuntime.mergeNotes = [
          ...(asPipelineRuntime.mergeNotes || []),
          asset.id +
            ": orphan scene links removed from proposal: " +
            missing.join(", "),
        ];
      return missing.length
        ? {
            ...asset,
            sceneIds: asset.sceneIds.filter((id) => knownScenes.has(id)),
          }
        : asset;
    });
  return merged;
}

async function asAnalysisLoadReview() {
  const id = Kl.getState().activeId,
    saved = await Wo("astra-analysis-review:" + id);
  if (Kl.getState().activeId !== id)
    throw Error("Project changed while loading review");
  if (!saved) throw Error("No saved analysis review");
  asPipelineRuntime.review = { ...saved, candidate: saved.candidate };
  asPipelineRuntime.reviewProjectId = id;
  asPipelineNotify();
}
