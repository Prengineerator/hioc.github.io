# Coffey question design: psychology and survey-methodology evidence

**Date:** 2026-09-29 · **Companion to:** `docs/COFFEY-SPEC.md` (§1–2) · **Status:** research brief for a product decision

**Summary.** The v2 question set is broadly supported: three curated picks sit at the low-risk end of the choice-overload literature, single-selects and explicit "drink / sweet / savoury" choices follow survey-methodology advice, and a fully labelled five-point unipolar sweetness scale with a separate "Any" is defensible on a phone. The evidence argues for eight adjustments: add a "Stressed" mood; keep Budget visible and make it a ceiling; make the Coffee options mutually exclusive; drop the "Savoury" flavour chip; rename the scale's bottom point "Not sweet" and calibrate the 0–10 item scale by measurement; treat late-day caffeine more cautiously than the spec; keep defaults visible, editable and logged; and fold "Treat myself" into Celebrating. Evidence strength varies: choice overload has a near-zero mean effect, emotion-and-food findings are mostly laboratory studies, and the rating-scale literature is not about sweetness.

**Outcome (2026-09-29).** Seven of the eight adjustments were adopted, recorded in `docs/COFFEY-SPEC.md` §8: the Stressed ("unwind") mood, visible budget ceilings (Up to ₹100 / ₹150 / ₹200 / Any), mutually exclusive coffee options, no Savoury flavour chip, "Not sweet" as the scale's bottom label, the caffeine ramp from 17:00, and "Treat myself" folded into Celebrating. The celebrate → dessert default stays visible and editable; logging its override rate is a follow-up. Two things remain judgement calls: calibrating the 0–10 item scale by measurement rather than by label, and the two-mood cap.

**Method note.** Details and abstract-level findings were checked against search records of publisher and repository pages. Fetching pages and DOI resolvers was blocked here, so no full text was read. "As summarised" marks findings resting on secondary summaries. **†** means the DOI could not be verified (journal details and any URL found are given instead). Menu figures come from `supabase/seed.sql` (120 items; production has 117).

## Decision table

| Question | Recommended format | Options (recommended wording) | Why | Evidence |
|---|---|---|---|---|
| **Mood** | Multi, capped at 2 (1 required); large cards in a 2×4 grid | Tired, need a boost · Focused (working or studying) · Calm & cosy · Low, need comfort · **Stressed, need to unwind (new)** · Celebrating, or treating myself · Hot, cool me down · Curious, surprise me | Mixed feelings occur mainly at bittersweet moments, so allow two, not more (the cap is a judgement; no test found). Seven cards miss the high-arousal negative quadrant. | Larsen01, Russell80, Desmet16, Oliver00, Smyth06 |
| **What would you like** | Multi (1 required; "A drink" pre-ticked) | A drink · Something sweet to eat · Something savoury | Non-exclusive and only three visible items, so check-all satisficing is a minor risk. Combinations allow a contrasting drink-and-bite pairing. | Smyth06, Callegaro15, Rolls81b |
| **Hot or iced** | Single | Hot · Iced · Either | Three options add negligible decision time. Show only when "A drink" is ticked; a pre-selected Iced must stay visible and editable. | Liu20, Jachimowicz19 |
| **Coffee** | Single | Strong coffee · Smooth & milky coffee · No coffee, caffeine is fine · No caffeine at all · Either | v2's "Caffeine-free" sits inside "No coffee", so options overlap. Strong versus smooth is a plausible taste split (bitterness tolerance is partly learned), but "strong" is ambiguous: add a one-line hint. | Ong18, Calvino90, Keast03 |
| **Sweetness** | Scale: single-select, unipolar, 5 labelled points, plus a separate "Any" | Not sweet · Lightly sweet · Medium · Sweet · Very sweet · Any | Five labelled points is standard advice for a unipolar quantity; six or seven are only marginally more reliable, and sliders add missing data, not precision. "No sugar" names an ingredient, not a taste level. | Krosnick10, Preston00, Simms19, Couper06, Iatridi19 |
| **Flavours** | Multi, soft, uncapped, none pre-ticked | Chocolatey · Caramel & toffee · Nutty · Cookies & biscuit · Fruity · Warm spice · Floral & tea | A soft preference, so under-selection costs little. "Savoury" repeats "Something savoury"; "Warm spice" avoids the chilli-hot reading of "spiced" (a wording judgement). | Smyth06, Pew19, Cowan01 |
| **Texture** | Single, inside "Fine-tune" | Light & refreshing · Rich & creamy · Any | Single-select removes v1's Light-plus-Filling contradiction. Texture is part of sensory appeal, a leading food-choice motive; it does not replace a hunger cue. | Steptoe95, NN06 |
| **Budget** | Single ceiling; keep visible (collapse Texture only) | Up to ₹100 · Up to ₹150 · Up to ₹200 · Any | Price is a core motive and hidden controls get missed. From the repo, not the literature: the engine's "₹150–₹300" band hides cheaper items, and no seed item's cheapest size exceeds ₹280, so "Treat myself" equals "Any". | Steptoe95, Bhagyanath26, NNmob |
| **Note** | Free text, optional, ≤140 characters | Tell Coffey anything (e.g. "studying late", "sharing with a friend") | A catch-all for needs the chips miss. Phone answers differ in length and style; a visible prompt improves quality. Treat the text as untrusted. | Smyth09, Revilla16 |

## 1. Choice overload and how many options

- [Iyengar00] Jams, six versus 24: the larger display drew more visitors, but about 3% of them bought, versus about 30% at the six-jam display.
- [Scheibehenne10] 63 conditions (N = 5,036): mean effect "virtually zero", large variance, no sufficient condition found.
- [Chernev15] 99 observations (N = 7,202): overload rises with set complexity, task difficulty, preference uncertainty and an effort-minimising goal. With these modelled, the overall effect is significant.
- [Reutskaja09] Satisfaction is an inverted U in option count (four experiments): fewer is not automatically better.
- [Bollen10; Willemsen16; Ziegler05] In recommender studies, large attractive lists were harder to choose from, while small diverse sets were as satisfying and less effortful. Diversifying cost accuracy but raised satisfaction.

**Implication for Coffey.** Three diverse picks suit customers unsure what they want (high preference uncertainty); two refinements cap exposure at nine. Keep each question to about eight options or fewer.

## 2. Hick–Hyman law and working memory

- [Hick52; Hyman53] Choice time grows with the logarithm of the number of equally likely alternatives.
- [Liu20] The law rarely describes real interfaces, where visual search and decisions dominate, and it does not support "less is always better".
- [Miller56] "Seven plus or minus two" concerns absolute judgement and memory span; [Cowan01] puts capacity near four chunks. Both concern items held in mind, not visible chips.

**Implication for Coffey.** A rule of thumb, not a threshold: up to five options for single-select, up to eight visible, grouped chips.

## 3. Check-all versus forced-choice; capping mood

- [Smyth06] In 16 experiments forced-choice drew more endorsements and slower answers than check-all: deeper processing, with check-all inviting weak satisficing, and no serious acquiescence problem.
- [Callegaro15] Endorsement is 1.42 times higher under forced-choice; acquiescence is a rival explanation. [Rasinski94] (as summarised) and [Pew19] (randomised, N = 4,581) also found fewer endorsements under mark-all.
- [Krosnick91] Satisficing rises with task difficulty and falls with motivation. No experiment on "select up to N" was found.

**Implication for Coffey.** Use multi-select only where combinations matter ("What would you like") or the answer is soft (Flavours). The cap of two moods is sensible but untested; [Larsen01] supports two, not more.

## 4. Rating-scale design for sweetness

- [Krosnick10] (as summarised; see also [Krosnick97]) About five points for unipolar and seven for bipolar constructs, every point labelled. [Schaeffer03] lists these as core design decisions.
- [Preston00] Two- to four-point scales performed worst and indices rose up to about seven points, though respondents preferred 10-, 7- and 9-point scales. [Simms19]: two to five options lost precision; nothing was gained beyond six or with visual analogues. [Couper06]: sliders gave the same distributions with more missing data and slower completion. [Weijters10]: labels and category count shift responses strongly.
- Just-about-right (JAR) scales are bipolar around an "ideal" (typically five or seven points) and diagnose a specific product [Rothman09]; [Lawless10] is the general sensory text (its JAR coverage was not checked). They blend intensity with acceptability, whereas ideal-point scaling separates them with similar insight [Li14].
- [Iatridi19] Sweet-liking differs by person (rising, inverted-U, falling). [Talavera05] Warmth raises perceived sweetness.

**Implication for Coffey.** Five labelled unipolar points plus "Any" is defensible; expect little gain from seven. "Any" can invite satisficing [Krosnick02], but a wrong forced answer costs a recommender more, so keep it and track its use. Use JAR only as a three-button after-order follow-up to calibrate item tags (a suggestion). Calibrate the 0–10 mapping from recipe sugar or a small tasting panel, and tag iced items as served.

## 5. Emotion and food choice

- [Macht08] Five pathways from emotion to eating, depending on the person and the emotion.
- [Oliver00] Under acute stress, emotional eaters ate more sweet, high-fat food and a more energy-dense meal than unstressed or non-emotional eaters.
- [Cardi15] 33 studies (N = 2,491): induced negative mood raised intake, especially in restrained and binge eaters; positive mood also raised intake.
- [Moynihan15] Boredom predicted calories, fat and sugar (diary); in a high self-awareness subgroup it also raised eating of "more exciting, healthy" foods.
- [Troisi11] Laboratory studies tie comfort food to relationship cues and lower loneliness in securely attached people; [Wagner14] comfort food lifted mood no more than other foods or none. [Gardner14] is Wansink-linked (flagged below); nothing here depends on it.

**Implication for Coffey.** Mood is a soft fit, never a filter. "Low, need comfort" should favour warm, familiar, creamy items but promise no mood benefit (as the tone guide already says). The stress-to-sweet effect applies to a subgroup.

## 6. Mixed emotions and the circumplex

- [Larsen01] In everyday situations most people felt happy or sad; after bittersweet events (a film, moving out, graduating) many felt both.
- [Russell80] Affect falls on a circle of pleasure and arousal; [Desmet16] Pick-A-Mood spans four quadrants: excited/cheerful, irritated/tense, relaxed/calm, bored/sad.
- Coverage: the seven cards reach three quadrants (Celebrating and Curious; Calm & cosy; Low and Tired) and none is energised-unpleasant. Focused, Hot and Celebrating are goals or situations, not core feelings.
- [Watson94] PANAS-X scores fatigue and attentiveness separately. [McLellan16] Caffeine reliably improves alertness, vigilance and attention, less consistently higher-order decisions. [Rogers13] Caffeine helped medium-high consumers, but in the non-low group it mainly reduced sleepiness, with jitteriness offsetting other gains.

**Implication for Coffey.** "Focused" is defensible as a distinct task state (sustained attention, sippable, not too sweet), and Tired + Focused is a natural pair. Add "Stressed": stress changes choices [Oliver00] and caffeine tolerance [Rogers13]. If the count must stay at seven, drop "Hot, cool me down", which Hot or iced already covers.

## 7. Food Choice Questionnaire

- [Steptoe95] 358 adults; nine motives: health, mood, convenience, sensory appeal, natural content, price, weight control, familiarity, ethical concern. They varied by sex, age and income.
- Mapping: mood → Step 1; sensory appeal → Hot or iced, Coffee, Sweetness, Flavours, Texture; price → Budget; familiarity → "Curious" (opposite pole) and "Your usual"; health and weight control → proxies only (Sweetness, No caffeine, Texture); convenience, natural content, ethical concern → not asked (low relevance here; "Note" catches "in a hurry").
- [Bhagyanath26] Kochi (680 adults; packaged food, not cafés): health, convenience and sensory appeal ranked highest; lower socio-economic groups were more price-conscious.

**Implication for Coffey.** Coverage is good; the at-risk motive is price, which v2 hides. Hunger is not an FCQ motive, but dropping "Filling" leaves an untested gap.

## 8. Food neophobia and neophilia

- [Pliner92] Food neophobia (reluctance to eat, or avoidance of, novel foods) is measurable as a trait; the 10-item scale had satisfactory reliability.
- Scores predicted behaviour in three laboratory food-selection studies.
- They correlated with trait anxiety, age and experience-seeking, not with gender or finickiness.

**Implication for Coffey.** An opt-in "Curious, surprise me" suits the adventurous minority. For other moods keep at least two of three picks familiar (novelty ≤1; the spec's 0–3 `novelty` trait supports this). This is an inference from laboratory choices.

## 9. Sensory-specific satiety and variety

- [Rolls81a] Eating a food lowers its pleasantness more than that of uneaten foods (as summarised).
- [Rolls81b] People ate a third more with four sandwich fillings, and more yoghurt when flavours differed in taste, texture and colour, but not in taste alone.
- [Ziegler05; Willemsen16] Diversity also raised satisfaction with recommendation lists.

**Implication for Coffey.** Diversify picks on several properties (category, temperature, flavour family, texture), as the MMR step does, and pair a drink with a contrasting bite. Caveats: effects were measured within meals, and variety raises intake, so do not use it to upsell.

## 10. Hedonic versus utilitarian choice; licensing

- [Okada05] Hedonic choices need justification: a hedonic option is rated higher alone, but the utilitarian one wins in joint display.
- [Dhar00] Hedonic attributes loom larger when deciding what to give up than what to acquire.
- [Khan06] Imagining volunteering raised the choice of designer jeans over a vacuum cleaner; [Kivetz02a; Kivetz02b] effort and reward framings support indulgence. [Blanken15] 91 studies: d = 0.31, with evidence of publication bias.

**Implication for Coffey.** "Celebrating" supplies a justification for pre-ticking a sweet item. Because joint display favours the "sensible" option, keep all three Celebrating picks on the treat side, varying form, not virtue (an inference). Licensing is too weak to design around. "Treat myself" is a motive, not a price: fold it into Celebrating.

## 11. Defaults

- [Johnson03] Consent rates differ sharply between opt-in and opt-out countries.
- [Jachimowicz19] 58 studies (N = 73,675): d = 0.68; stronger when the default signals endorsement or reflects the status quo, and in consumer domains.
- [Mertens22] d = 0.45 across choice-architecture interventions, with food up to 2.5 times more responsive; [Maier22] found no evidence for nudging after adjusting for publication bias, so sizes are contested.

**Implication for Coffey.** Keep defaults visible, editable, applied once and logged for override rates. Preselect sugar only when the customer stated a level, never for "Any". "Celebrating → dessert" is the only default that adds sugar without the customer asking: retire it if many customers untick it, and never pre-tick a sweeter option after "Not sweet" or "Lightly sweet".

## 12. Caffeine timing and sleep

- [Drake13] Twelve healthy sleepers took 400 mg caffeine at bedtime, or 3 or 6 hours before; all disturbed sleep. At 6 hours objective sleep fell by over an hour, unnoticed by participants.
- [Gardiner23] 24 studies: caffeine cut total sleep by 45 minutes and sleep efficiency by 7%.
- [EFSA15] (as summarised) about 100 mg can affect sleep in some adults near bedtime.

**Implication for Coffey.** Yes: a soft ranking penalty, never a filter, when caffeine was not requested. Quiet re-ranking is acceptable while nothing is removed and the tone guide's no-health-claims rule holds. Start the ramp near 17:00, not at the spec's 21:00 "late" boundary (this assumes a roughly midnight bedtime, which is unknown). Exempt only explicit asks (Strong or Smooth coffee, Tired), not "Focused": studying late is where sleep costs most. Keep one caffeine-free pick. Cocoa is not strictly caffeine-free (consumer sources: about 5–25 mg a cup; no authoritative figure verified), so word "No caffeine" carefully.

## 13. Bitterness and coffee liking

- [Ong18] Mendelian randomisation (up to 438,870 people): higher genetically predicted caffeine-bitterness perception predicted more coffee (+0.146 cups a day per SD); higher PROP and quinine perception predicted less (−0.021 and −0.081). This fits learned reinforcement by caffeine.
- [Calvino90; Keast03] Sucrose suppresses caffeine bitterness and coffee flavour and is among the strongest suppressors of other tastes.
- "Cornelis et al. 2016" was not located; the closest verified study is [Ong18] (last author M. C. Cornelis).

**Implication for Coffey.** Strong versus smooth is plausible but not a genetic proxy. Sugar is a bitterness lever, so treat strength and sweetness as independent soft preferences ("Strong + Very sweet" is legitimate).

## 14. Progressive disclosure

- [NN06] Defer advanced or rarely used features; it aids learnability, efficiency and errors. More than two levels usually fails, and choosing what to defer is the hard part.
- [NNmob] Hidden content gets less attention; descriptive headings help.
- [Galesic09] In longer questionnaires, later answers were faster, shorter and more uniform.

**Implication for Coffey.** Texture suits "Fine-tune"; Budget probably does not. Keep the current-values summary and auto-open on a non-default, track the open rate, and order Step 2 by importance.

## Where the evidence is weak or mixed

- **Choice overload:** near-zero mean effect, moderator-dependent [Scheibehenne10]; the jam study is one field study; nothing tests three picks against one or five in a café.
- **Caps and cards:** no test of "select up to N"; cards mixing feelings, tasks and situations are untested.
- **Scales:** evidence comes from attitude, personality and satisfaction items, not sweetness; five versus seven points differ slightly; labels are not equal-interval, so the spec's 0/3/5/7/10 mapping is uncalibrated; JAR evidence is product testing and the inverted-U liking pattern comes from sucrose solutions.
- **Emotion and food:** mostly laboratory studies, often effects only in emotional eaters; comfort-food mood benefits are unsupported [Wagner14].
- **Defaults:** contested sizes [Maier22]; none tested for sugar in cafés.
- **Caffeine:** [Drake13] had 12 people at a large dose (400 mg); a customer's bedtime is unknown.
- **FCQ and neophobia:** 1995 UK instrument; Indian evidence covers packaged food; the neophobia scale predicted laboratory choices only.
- **Progressive disclosure:** practitioner guidance; no experiment on this design.

## Retracted / flagged sources

- **[Gardner14]** (Wansink co-author). Cornell found misconduct; counts vary (at least 13, by later counts 18, retractions; at least 15 corrections). No notice for this paper surfaced, but Retraction Watch and the publisher page could not be opened, so it is **not verified clean**. Cited only as a flagged pointer; nothing depends on it.
- No other cited source is Wansink-authored (comfort-food evidence: [Troisi11], [Wagner14]). Retraction status of the rest was not exhaustively checked, and no notice surfaced.
- Cautions, not retractions: [Iyengar00]'s jam result is a single field study, and later meta-analyses found a near-zero mean effect; [Troisi11] and [Oliver00] are single-lab laboratory studies without verified independent replication.
- Not located, not cited: "Cornelis et al. 2016" (§13); Epler, Chambers and Kemp (1998, JAR versus hedonic scales for lemonade); Proctor and Schneider (2018, Hick's law).
- Rests on secondary summaries: [Rasinski94], [EFSA15], [Krosnick10] (scale-point advice), [Rolls81a].

## References

**Choice overload**
- **Iyengar00** Iyengar, S. S., & Lepper, M. R. (2000). When choice is demotivating: Can one desire too much of a good thing? *Journal of Personality and Social Psychology, 79*(6), 995–1006. https://doi.org/10.1037/0022-3514.79.6.995
- **Scheibehenne10** Scheibehenne, B., Greifeneder, R., & Todd, P. M. (2010). Can there ever be too many options? A meta-analytic review of choice overload. *Journal of Consumer Research, 37*(3), 409–425. https://doi.org/10.1086/651235
- **Chernev15** Chernev, A., Böckenholt, U., & Goodman, J. (2015). Choice overload: A conceptual review and meta-analysis. *Journal of Consumer Psychology, 25*(2), 333–358. https://doi.org/10.1016/j.jcps.2014.08.002
- **Reutskaja09** Reutskaja, E., & Hogarth, R. M. (2009). Satisfaction in choice as a function of the number of alternatives: When "goods satiate". *Psychology & Marketing, 26*(3), 197–203. † https://bse.eu/research/publications/satisfaction-choice-function-number-alternatives-when-goods-satiate
- **Bollen10** Bollen, D., Knijnenburg, B. P., Willemsen, M. C., & Graus, M. (2010). Understanding choice overload in recommender systems. *Proceedings of ACM RecSys 2010*, 63–70. https://doi.org/10.1145/1864708.1864724
- **Willemsen16** Willemsen, M. C., Graus, M. P., & Knijnenburg, B. P. (2016). Understanding the role of latent feature diversification on choice difficulty and satisfaction. *User Modeling and User-Adapted Interaction, 26*, 347–389. https://doi.org/10.1007/s11257-016-9178-6
- **Ziegler05** Ziegler, C.-N., McNee, S. M., Konstan, J. A., & Lausen, G. (2005). Improving recommendation lists through topic diversification. *Proceedings of WWW 2005*, 22–32. https://doi.org/10.1145/1060745.1060754

**Choice time and memory**
- **Hick52** Hick, W. E. (1952). On the rate of gain of information. *Quarterly Journal of Experimental Psychology, 4*(1), 11–26. https://doi.org/10.1080/17470215208416600
- **Hyman53** Hyman, R. (1953). Stimulus information as a determinant of reaction time. *Journal of Experimental Psychology, 45*(3), 188–196. †
- **Liu20** Liu, W., Gori, J., Rioul, O., Beaudouin-Lafon, M., & Guiard, Y. (2020). How relevant is Hick's law for HCI? *Proceedings of CHI 2020*, 1–11. † https://researchportal.ip-paris.fr/en/publications/how-relevant-is-hicks-law-for-hci/
- **Miller56** Miller, G. A. (1956). The magical number seven, plus or minus two: Some limits on our capacity for processing information. *Psychological Review, 63*(2), 81–97. https://doi.org/10.1037/h0043158
- **Cowan01** Cowan, N. (2001). The magical number 4 in short-term memory: A reconsideration of mental storage capacity. *Behavioral and Brain Sciences, 24*(1), 87–114. https://doi.org/10.1017/S0140525X01003922

**Survey formats and burden**
- **Smyth06** Smyth, J. D., Dillman, D. A., Christian, L. M., & Stern, M. J. (2006). Comparing check-all and forced-choice question formats in Web surveys. *Public Opinion Quarterly, 70*(1), 66–77. https://doi.org/10.1093/poq/nfj007
- **Rasinski94** Rasinski, K. A., Mingay, D., & Bradburn, N. M. (1994). Do respondents really "mark all that apply" on self-administered questions? *Public Opinion Quarterly, 58*(3), 400–408. † (abstract not accessed)
- **Callegaro15** Callegaro, M., Murakami, M., Tepman, Z., & Henderson, V. (2015). Yes–no answers versus check-all in self-administered modes: A systematic review and analyses. *International Journal of Market Research*, 203–223. † https://research.google/pubs/yesno-answers-versus-check-all-in-self-administered-modes-a-systematic-review-and-analyses/
- **Pew19** Lau, A., & Kennedy, C. (2019). When online survey respondents only "select some that apply". Pew Research Center. https://www.pewresearch.org/methods/2019/05/09/when-online-survey-respondents-only-select-some-that-apply/
- **Krosnick91** Krosnick, J. A. (1991). Response strategies for coping with the cognitive demands of attitude measures in surveys. *Applied Cognitive Psychology, 5*(3), 213–236. † https://www.scinapse.io/papers/2010398643
- **Krosnick02** Krosnick, J. A., Holbrook, A. L., Berent, M. K., et al. (2002). The impact of "no opinion" response options on data quality: Non-attitude reduction or an invitation to satisfice? *Public Opinion Quarterly, 66*(3), 371–403. † https://rff.org/publications/journal-articles/the-impact-of-quotno-opinionquot-response-options-on-data-quality-non-attitude-reduction-or-an-invitation-to-satisfice
- **Galesic09** Galesic, M., & Bosnjak, M. (2009). Effects of questionnaire length on participation and indicators of response quality in a web survey. *Public Opinion Quarterly, 73*(2), 349–360. †
- **Smyth09** Smyth, J. D., Dillman, D. A., Christian, L. M., & McBride, M. (2009). Open-ended questions in web surveys: Can increasing the size of answer boxes and providing extra verbal instructions improve response quality? *Public Opinion Quarterly, 73*(2), 325–337. † https://digitalcommons.unl.edu/sociologyfacpub/668
- **Revilla16** Revilla, M., & Ochoa, C. (2016). Open narrative questions in PC and smartphones: Is the device playing a role? *Quality & Quantity, 50*(6), 2495–2513. https://doi.org/10.1007/s11135-015-0273-2

**Rating scales, JAR and sweetness**
- **Krosnick10** Krosnick, J. A., & Presser, S. (2010). Question and questionnaire design. In P. V. Marsden & J. D. Wright (Eds.), *Handbook of Survey Research* (2nd ed., pp. 263–313). Emerald. † https://web.stanford.edu/dept/communication/faculty/krosnick/docs/2010/2010%20Handbook%20of%20Survey%20Research.pdf
- **Krosnick97** Krosnick, J. A., & Fabrigar, L. R. (1997). Designing rating scales for effective measurement in surveys. In L. Lyberg et al. (Eds.), *Survey Measurement and Process Quality* (pp. 141–164). Wiley. † https://data.gesis.org/gesiskg/resource/zis-KrosnickFabrigar1997Designing
- **Schaeffer03** Schaeffer, N. C., & Presser, S. (2003). The science of asking questions. *Annual Review of Sociology, 29*, 65–88. https://doi.org/10.1146/annurev.soc.29.110702.110112
- **Preston00** Preston, C. C., & Colman, A. M. (2000). Optimal number of response categories in rating scales: Reliability, validity, discriminating power, and respondent preferences. *Acta Psychologica, 104*(1), 1–15. †
- **Simms19** Simms, L. J., Zelazny, K., Williams, T. F., & Bernstein, L. (2019). Does the number of response options matter? Psychometric perspectives using personality questionnaire data. *Psychological Assessment, 31*(4), 557–566. † https://researchconnect.buffalo.edu/en/publications/does-the-number-of-response-options-matter-psychometric-perspecti/
- **Couper06** Couper, M. P., Tourangeau, R., Conrad, F. G., & Singer, E. (2006). Evaluating the effectiveness of visual analog scales: A web experiment. *Social Science Computer Review, 24*(2), 227–245. †
- **Weijters10** Weijters, B., Cabooter, E., & Schillewaert, N. (2010). The effect of rating scale format on response styles: The number of response categories and response category labels. *International Journal of Research in Marketing, 27*(3), 236–247. † https://ideas.repec.org/a/eee/ijrema/v27y2010i3p236-247.html
- **Rothman09** Rothman, L., & Parker, M. J. (Eds.). (2009). *Just-About-Right (JAR) Scales: Design, Usage, Benefits, and Risks* (ASTM MNL63). ASTM International. https://store.astm.org/mnl63-eb.html
- **Lawless10** Lawless, H. T., & Heymann, H. (2010). *Sensory Evaluation of Food: Principles and Practices* (2nd ed.). Springer. https://doi.org/10.1007/978-1-4419-6488-5
- **Li14** Li, B., Hayes, J. E., & Ziegler, G. R. (2014). Just-about-right and ideal scaling provide similar insights into the influence of sensory attributes on liking. *Food Quality and Preference, 37*, 71–78. † https://pmc.ncbi.nlm.nih.gov/articles/PMC4104712
- **Iatridi19** Iatridi, V., Hayes, J. E., & Yeomans, M. R. (2019). Quantifying sweet taste liker phenotypes: Time for some consistency in the classification criteria. *Nutrients, 11*(1), 129. † https://pmc.ncbi.nlm.nih.gov/articles/PMC6357166
- **Talavera05** Talavera, K., et al. (2005). Heat activation of TRPM5 underlies thermal sensitivity of sweet taste. *Nature, 438*(7070), 1022–1025. https://doi.org/10.1038/nature04248

**Emotion, mood and caffeine effects**
- **Macht08** Macht, M. (2008). How emotions affect eating: A five-way model. *Appetite, 50*(1), 1–11. †
- **Oliver00** Oliver, G., Wardle, J., & Gibson, E. L. (2000). Stress and food choice: A laboratory study. *Psychosomatic Medicine, 62*(6), 853–865. † https://pubmed.ncbi.nlm.nih.gov/11139006
- **Cardi15** Cardi, V., Leppanen, J., & Treasure, J. (2015). The effects of negative and positive mood induction on eating behaviour: A meta-analysis of laboratory studies in the healthy population and eating and weight disorders. *Neuroscience & Biobehavioral Reviews, 57*, 299–309. † (record found via search; no stable URL verified)
- **Moynihan15** Moynihan, A. B., van Tilburg, W. A. P., Igou, E. R., Wisman, A., Donnelly, A. E., & Mulcaire, J. B. (2015). Eaten up by boredom: Consuming food to escape awareness of the bored self. *Frontiers in Psychology, 6*, 369. https://doi.org/10.3389/fpsyg.2015.00369
- **Troisi11** Troisi, J. D., & Gabriel, S. (2011). Chicken soup really is good for the soul: "Comfort food" fulfills the need to belong. *Psychological Science, 22*(6), 747–753. † https://ubwp.buffalo.edu/gabriellab/wp-content/uploads/sites/65/2025/04/Troisi-J-Gabriel-S-2011.-Chicken-soup-really-is-good-for-the-soul-Comfort-food-fulfills-the-need-to-belong.pdf
- **Wagner14** Wagner, H. S., Ahlstrom, B., Redden, J. P., Vickers, Z., & Mann, T. (2014). The myth of comfort food. *Health Psychology, 33*(12), 1552–1557. † https://pubmed.ncbi.nlm.nih.gov/25133833/
- **Gardner14 (FLAGGED, Wansink co-author)** Gardner, M. P., Wansink, B., Kim, J., & Park, S.-B. (2014). Better moods for better eating? How mood influences food choice. *Journal of Consumer Psychology, 24*(3), 320–335. https://doi.org/10.1016/j.jcps.2014.01.002
- **Larsen01** Larsen, J. T., McGraw, A. P., & Cacioppo, J. T. (2001). Can people feel happy and sad at the same time? *Journal of Personality and Social Psychology, 81*(4), 684–696. https://doi.org/10.1037/0022-3514.81.4.684
- **Russell80** Russell, J. A. (1980). A circumplex model of affect. *Journal of Personality and Social Psychology, 39*(6), 1161–1178. https://doi.org/10.1037/h0077714
- **Desmet16** Desmet, P. M. A., Vastenburg, M. H., & Romero, N. (2016). Mood measurement with Pick-A-Mood: Review of current methods and design of a pictorial self-report scale. *Journal of Design Research, 14*(3), 241–279. † https://research.tudelft.nl/en/publications/mood-measurement-with-a-pick-a-mood-review-of-current-methods-and/
- **Watson94** Watson, D., & Clark, L. A. (1994). *The PANAS-X: Manual for the Positive and Negative Affect Schedule – Expanded Form*. University of Iowa. † https://iro.uiowa.edu/esploro/outputs/9983557488402771
- **McLellan16** McLellan, T. M., Caldwell, J. A., & Lieberman, H. R. (2016). A review of caffeine's effects on cognitive, physical and occupational performance. *Neuroscience & Biobehavioral Reviews, 71*, 294–312. †
- **Rogers13** Rogers, P. J., Heatherley, S. V., Mullings, E. L., & Smith, J. E. (2013). Faster but not smarter: Effects of caffeine and caffeine withdrawal on alertness and performance. *Psychopharmacology, 226*(2), 229–240. † https://shura.shu.ac.uk/23498/

**Food-choice motives, novelty, satiety**
- **Steptoe95** Steptoe, A., Pollard, T. M., & Wardle, J. (1995). Development of a measure of the motives underlying the selection of food: The Food Choice Questionnaire. *Appetite, 25*(3), 267–284. † https://agris.fao.org/search/es/records/65e00b616eef00c2cea3a5ef
- **Bhagyanath26** Bhagyanath, E. R., Sreedevi, A., Santos, S. R., Bhaskaran, R., & Gittelsohn, J. (2026). Urban consumer behaviors in Kochi, India: Food choice motivations, food label literacy, and nutrition panel use. *International Journal of Food Science*. https://doi.org/10.1155/ijfo/6568539
- **Pliner92** Pliner, P., & Hobden, K. (1992). Development of a scale to measure the trait of food neophobia in humans. *Appetite, 19*(2), 105–120. https://doi.org/10.1016/0195-6663(92)90014-W
- **Rolls81a** Rolls, B. J., Rolls, E. T., Rowe, E. A., & Sweeney, K. (1981). Sensory specific satiety in man. *Physiology & Behavior, 27*(1), 137–142. † https://pure.psu.edu/en/publications/sensory-specific-satiety-in-man/
- **Rolls81b** Rolls, B. J., Rowe, E. A., Rolls, E. T., Kingston, B., Megson, A., & Gunary, R. (1981). Variety in a meal enhances food intake in man. *Physiology & Behavior, 26*(2), 215–221. † https://pure.psu.edu/en/publications/variety-in-a-meal-enhances-food-intake-in-man/

**Hedonic choice and defaults**
- **Okada05** Okada, E. M. (2005). Justification effects on consumer choice of hedonic and utilitarian goods. *Journal of Marketing Research, 42*(1), 43–53. https://doi.org/10.1509/jmkr.42.1.43.56889
- **Dhar00** Dhar, R., & Wertenbroch, K. (2000). Consumer choice between hedonic and utilitarian goods. *Journal of Marketing Research, 37*(1), 60–71. https://doi.org/10.1509/jmkr.37.1.60.18718
- **Khan06** Khan, U., & Dhar, R. (2006). Licensing effect in consumer choice. *Journal of Marketing Research, 43*(2), 259–266. †
- **Kivetz02a** Kivetz, R., & Simonson, I. (2002). Earning the right to indulge: Effort as a determinant of customer preferences toward frequency program rewards. *Journal of Marketing Research, 39*(2), 155–170. † https://business.columbia.edu/sites/default/files-efs/pubfiles/944/Frequency_Program_Rewards.pdf
- **Kivetz02b** Kivetz, R., & Simonson, I. (2002). Self-control for the righteous: Toward a theory of precommitment to indulgence. *Journal of Consumer Research, 29*(2), 199–217. † https://business.columbia.edu/sites/default/files-efs/pubfiles/943/Self_Control_Righteous.pdf
- **Blanken15** Blanken, I., van de Ven, N., & Zeelenberg, M. (2015). A meta-analytic review of moral licensing. *Personality and Social Psychology Bulletin, 41*(4), 540–558. https://doi.org/10.1177/0146167215572134
- **Johnson03** Johnson, E. J., & Goldstein, D. (2003). Do defaults save lives? *Science, 302*(5649), 1338–1339. https://doi.org/10.1126/science.1091721
- **Jachimowicz19** Jachimowicz, J. M., Duncan, S., Weber, E. U., & Johnson, E. J. (2019). When and why defaults influence decisions: A meta-analysis of default effects. *Behavioural Public Policy, 3*(2), 159–186. † https://business.columbia.edu/faculty/research/when-and-why-defaults-influence-decisions-meta-analysis-default-effects
- **Mertens22** Mertens, S., Herberz, M., Hahnel, U. J. J., & Brosch, T. (2022). The effectiveness of nudging: A meta-analysis of choice architecture interventions across behavioral domains. *PNAS, 119*(1), e2107346118. † https://pmc.ncbi.nlm.nih.gov/articles/PMC8740589
- **Maier22** Maier, M., Bartoš, F., Stanley, T. D., Shanks, D. R., Harris, A. J. L., & Wagenmakers, E.-J. (2022). No evidence for nudging after adjusting for publication bias. *PNAS, 119*(31), e2200300119. † https://pmc.ncbi.nlm.nih.gov/articles/PMC9351501

**Caffeine, bitterness and interface guidance**
- **Drake13** Drake, C., Roehrs, T., Shambroom, J., & Roth, T. (2013). Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed. *Journal of Clinical Sleep Medicine, 9*(11), 1195–1200. † https://pmc.ncbi.nlm.nih.gov/articles/PMC3805807/
- **Gardiner23** Gardiner, C., Weakley, J., Burke, L. M., et al. (2023). The effect of caffeine on subsequent sleep: A systematic review and meta-analysis. *Sleep Medicine Reviews, 69*, 101764. † https://acuresearchbank.acu.edu.au/item/8zqv7/the-effect-of-caffeine-on-subsequent-sleep-a-systematic-review-and-meta-analysis
- **EFSA15** EFSA Panel on Dietetic Products, Nutrition and Allergies (2015). Scientific opinion on the safety of caffeine. *EFSA Journal*. † https://www.efsa.europa.eu/en/topics/topic/caffeine
- **Ong18** Ong, J.-S., Hwang, L.-D., Zhong, V. W., et al., & Cornelis, M. C. (2018). Understanding the role of bitter taste perception in coffee, tea and alcohol consumption through Mendelian randomization. *Scientific Reports, 8*, 16414. † https://pmc.ncbi.nlm.nih.gov/articles/PMC6237869
- **Calvino90** Calviño, A. M., García-Medina, M. R., & Cometto-Muñiz, J. E. (1990). Interactions in caffeine–sucrose and coffee–sucrose mixtures: Evidence of taste and flavor suppression. *Chemical Senses, 15*(5), 505–519. https://doi.org/10.1093/chemse/15.5.505
- **Keast03** Keast, R. S. J., & Breslin, P. A. S. (2003). An overview of binary taste–taste interactions. *Food Quality and Preference, 14*(2), 111–124. † https://dro.deakin.edu.au/articles/journal_contribution/An_overview_of_binary_taste-taste_interactions/20542116
- **NN06** Nielsen, J. (2006). Progressive disclosure. Nielsen Norman Group. https://www.nngroup.com/articles/progressive-disclosure/
- **NNmob** Nielsen Norman Group. Accordions on mobile. https://www.nngroup.com/articles/mobile-accordions/
