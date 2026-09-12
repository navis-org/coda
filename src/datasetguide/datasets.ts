/**
 * The Dataset Guide's content — one entry per preconfigured dataset, and the short list of
 * connectomes that exist but have no node here.
 *
 * **This file is the guide.** `main.ts` beside it draws whatever is in here and names no
 * dataset; `datasets.html` is a masthead and two slots. So editing the page means editing this
 * table, and a dataset added to `DATASET_FAMILIES` next month needs a line here — which
 * `datasetGuide.test.ts` enforces in both directions rather than leaving to notice.
 *
 * ## Why the label, backend and glyph are repeated from the family table
 *
 * They are a second spelling, and normally that would be the objection that ends the idea. The
 * page cannot import `nodes/lib/datasetFamilies.ts`: it reaches `data/catmaid/registry.ts` for
 * `L1_CATMAID_SOURCE_ID`, which constructs a `CatmaidSource`, and `tableOps` for
 * `aggColumnName` — the whole data layer behind a static document that is meant to cost
 * kilobytes. The node guide answers the same problem by loading the registry in Node at build
 * time (`vite/nodeGuideData.ts`, 660 kB measured, ~250 ms per build); that is the right trade
 * for 102 nodes drawn from 102 definitions and the wrong one for three fields on a dozen rows.
 *
 * So the three fields are copied and `datasetGuide.test.ts` holds each against the family table,
 * which is `anatomy.test.ts`' arrangement: a hand-written figure whose every glyph and title is
 * pinned against the source it depicts. The test runs in the app project where importing the
 * registry is free.
 *
 * Everything else here is editorial and exists nowhere else — `DatasetFamily.description` and
 * `.guide` are a card's one-liner and a card's tooltip, written for somebody who has already
 * picked, and this page is for somebody who has not.
 *
 * ## Voice
 *
 * The reader is a connectomics researcher deciding which volume to open, not somebody learning
 * what a connectome is. `docs/help.md`'s `## Voice` applies: write for somebody who knows the
 * field, and cut anything that is not about *this dataset*.
 *
 * `strengths` and `caveats` are the opinionated half and the reason the page exists — a reader
 * can get a neuron count anywhere. Each is one sentence, no leading bullet, no trailing full
 * stop needed. Say what it costs you, not what it is.
 *
 * ## TODO before this ships
 *
 * Entries marked `// TODO(facts)` carry numbers or citations that were not verifiable from
 * inside this repository. Every DOI that *is* here was taken from something already committed —
 * `data/neuprint/__fixtures__/datasets.json`, `data/cave/spec.ts`, `src/help/nodes/*.md` — or
 * from the ecosystem post the page is modelled on. Check the rest against the publisher before
 * the DRAFT banner comes off `datasets.html`.
 */

import type { DatasetGlyph } from '../nodes/lib/datasetFamilies'

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Where a dataset sits in the reader's decision, which is what orders the page.
 *
 * Not the family table's grouping, and deliberately not the New menu's: a reader who does not
 * know which dataset to use is not asking which backend serves it. `historical` is derived
 * information that happens to be stated twice — every family carrying `starter: false` belongs
 * in it — and the test pins that, so a dataset retired in the family table cannot keep its
 * recommendation here.
 */
export type Tier = 'start' | 'reach' | 'historical'

export interface TierDef {
  id: Tier
  title: string
  /** The sentence under the tier heading. Says who this tier is for. */
  note: string
}

export const TIERS: readonly TierDef[] = [
  {
    id: 'start',
    title: 'Start here',
    note: 'If you have no reason to pick otherwise, pick one of these. They are our first picks in their respective category.',
  },
  {
    id: 'reach',
    title: 'Alternatives',
    note: 'The datasets below all have their place but some come with caveats you should be aware of.',
  },
  {
    id: 'historical',
    title: 'Legacy datasets',
    note: 'These predate the more recent dense, large-scale datasets. Kept for historical reference and as playgrounds.',
  },
]

/**
 * What the volume was cut out of, which is the other axis a reader filters the table on.
 *
 * A field rather than something read out of `DatasetSpecs.specimen`: that string is prose
 * ("Adult male Drosophila", "First-instar Drosophila larva", "Mouse"), and a tab whose
 * membership is decided by a substring match is a tab that silently loses a dataset the day
 * somebody rewords a cell.
 *
 * The table is ordered as the tabs are drawn, and `render.ts` draws only the clades that have a
 * row — so a zebrafish dataset gets a tab by being given a clade, and a clade nothing uses draws
 * nothing rather than an empty tab.
 */
export type CladeId = 'fly' | 'fly-larva' | 'mouse'

export interface CladeDef {
  id: CladeId
  /** The tab's own word. Short: this is a pill in a row of them. */
  label: string
}

export const CLADES: readonly CladeDef[] = [
  { id: 'fly', label: 'Fly' },
  { id: 'fly-larva', label: 'Fly larva' },
  { id: 'mouse', label: 'Mouse' },
]

/** Where a dataset can be got at, and whether Coda is one of those places. */
export interface Repository {
  /** The platform, as its operators call it: `neuPrint`, `Codex`, `CAVE`, `CATMAID`. */
  name: string
  url: string
  /**
   * The node that opens it, or absent where Coda cannot.
   *
   * A repository Coda does not read is worth listing anyway — it is usually where the
   * annotations, the bulk download or the segmentation viewer live.
   */
  inCoda?: string
  /** One clause on what this platform gives you that the others do not. */
  note?: string
}

/** A paper, and what it is the citation *for*. */
export interface Citation {
  /** As it should read in a sentence: `Scheffer et al. (2020)`. */
  text: string
  url: string
  /** The thing this paper published: `the connectome`, `the EM volume`, `the annotations`. */
  what: string
  /**
   * Whether omitting it misattributes the work, as opposed to under-crediting it.
   *
   * Drawn as a distinct mark, because the FlyWire and MANC lists are long enough that a reader
   * skims them, and the one they must not skip is not always the first.
   */
  required?: boolean
}

/** A client library for working with the dataset outside Coda. */
export interface Toolkit {
  name: string
  language: 'R' | 'Python'
  url: string
}

/**
 * The at-a-glance row, and the columns of the comparison table at the top of the page.
 *
 * All strings, all editorial: the live listing answers none of these except the neuron count,
 * and that one only for the population the server calls `:Neuron` — which for hemibrain is
 * 186,061 rows and mostly untraced fragments. A number here is the number the publisher states.
 *
 * Keep them short. The table has a row per dataset and this is a page, not a spreadsheet.
 */
export interface DatasetSpecs {
  /** `Adult male Drosophila`, `First-instar larva`, `Mouse`. */
  specimen: string
  /** What the volume covers: `Whole CNS`, `Central brain (≈ half)`. */
  region: string
  /** As the publisher states it: `~167,000 proofread`. */
  neurons: string
  /** `Dense`, `Dense in brain, sparse elsewhere`, `Sparse (hand-traced)`. */
  completeness: string
  /** Voxel size, `x × y × z nm`. */
  resolution: string
  /** Year of the paper the dataset is cited by, not the year of the latest materialization. */
  released: string
}

export interface DatasetGuideEntry {
  /** The family key. The node type is `dataset.<key>`, and this is what the test joins on. */
  key: string
  /** Repeated from `DatasetFamily.label`. Pinned by the test — see the header. */
  label: string
  /** Repeated from `DatasetFamily.backend`. Sets `data-backend`, which `theme.css` tints. */
  backend: 'neuprint' | 'cave' | 'catmaid' | 'mock'
  /** Repeated from `DatasetFamily.glyph`. */
  glyph: DatasetGlyph
  tier: Tier
  /** Which tab of the comparison table it appears under. */
  clade: CladeId
  /** One line under the heading. What it is, in a reader's terms rather than a publisher's. */
  tagline: string
  specs: DatasetSpecs
  /** Two short paragraphs: what it is, who made it, what it was built to answer. Markdown. */
  about: string
  /** Opinionated. One sentence each. See the header. */
  strengths: readonly string[]
  caveats: readonly string[]
  /** Where it lives. The platform Coda reads goes first. */
  repositories: readonly Repository[]
  /** What to cite. Ordered so the one that cannot be omitted is first. */
  citations: readonly Citation[]
  toolkits?: readonly Toolkit[]
  /**
   * Optional: the dataset a reader is most likely to be choosing between this and, and why they
   * would end up here. Drawn as a one-line footer on the card.
   */
  ratherThan?: string
}

/**
 * Families deliberately left out of the list, and what is said instead.
 *
 * A declaration rather than an omission, which is the whole point: `datasetGuide.test.ts` asks
 * that every family is either in `DATASET_GUIDE` or named here, so a dataset added next month
 * cannot fall out of the guide by nobody noticing — leaving one out has to be typed.
 *
 * `footnote` is where a reader meets it instead. Optional, because the two reasons for leaving a
 * family out are different: this one is *not a connectome*, and still wants saying somewhere
 * because it is the answer to "I have no token yet"; a family excluded for being broken or
 * withdrawn would want no paragraph at all.
 */
export interface ExcludedEntry {
  key: string
  /** Why it is not in the list. For the reader of this file, and for the test's message. */
  why: string
  /** Markdown, drawn under the comparison table. Absent means it is not mentioned at all. */
  footnote?: string
}

export const EXCLUDED: readonly ExcludedEntry[] = [
  {
    key: 'mock.opticlobe',
    why: 'Not a connectome — generated in the browser, so it has no specimen, no resolution and nothing to cite. A row in a table comparing volumes would be six cells of “n/a” and one real claim.',
    footnote: `**Demo Data** is not in the table: it is a synthetic dataset user for demonstration purposes only. It needs no account and fetches nothing.`,
  },
]

// ---------------------------------------------------------------------------
// The datasets
// ---------------------------------------------------------------------------

/**
 * In page order, which is `TIERS` order and then this array's order within a tier.
 *
 * Deliberately not the family table's order: that one is grouped by backend because the New
 * menu is, and this page answers a question the New menu does not ask.
 */
export const DATASET_GUIDE: readonly DatasetGuideEntry[] = [
  // -------------------------------------------------------------------------
  // Start here
  // -------------------------------------------------------------------------
  {
    key: 'malecns',
    label: 'MaleCNS',
    backend: 'neuprint',
    glyph: 'fly_cns',
    tier: 'start',
    clade: 'fly',
    tagline: 'The whole central nervous system of an adult male fly.',
    specs: {
      specimen: 'Adult male Drosophila',
      region: 'Whole CNS — brain and ventral nerve cord',
      neurons: '~166,700 proofread',
      completeness: 'Dense',
      resolution: '8 × 8 × 8 nm',
      released: '2026',
    },
    about: `A whole-CNS (brain and nerve cord) reconstruction. A collaboration between Janelia FlyEM project, Google Connectomics and the University of Cambridge.
The largest and most complete fly connectome to date.`,
    strengths: [
      'High synaptic completion rate (fraction of synapses attached to proofread neurons)',
      'Brain & nerve cord in one volume let you trace full circuits from sensory input to motor output',
      'Densely annotated with e.g. types, classes, hemilineages, neurotransmitters, sexual dimorphism and cross-referenced to the literature',
      'Cross-references to hemibrain, FlyWire and MANC as first-class columns',
      'Served via neuPrint, which provides the most complete set of queries',
    ],
    caveats: ['None, unless you need a female brain'],
    repositories: [
      {
        name: 'neuPrint',
        url: 'https://neuprint.janelia.org',
        inCoda: 'MaleCNS (neuPrint)',
        note: 'connectivity, annotations and skeletons; needs a free account for a token',
      },
      {
        name: 'Project page',
        url: 'https://male-cns.janelia.org/',
        note: 'project overview with links to raw data downloads',
      },
    ],
    citations: [
      {
        text: 'Berg et al. (2026)',
        url: 'https://www.biorxiv.org/content/10.1101/2025.10.09.680999v1',
        what: 'the connectome',
        required: true,
      },
      {
        text: 'Nern et al. (2025)',
        url: 'https://doi.org/10.1038/s41586-025-08746-0', // TODO(facts): verify
        what: 'carries the optic lobe cell typing',
        required: false,
      },
      // TODO(facts): replace the bioRxiv link once the journal version is out.
    ],
    toolkits: [
      { name: 'malecns', language: 'R', url: 'https://github.com/natverse/malecns' },
      {
        name: 'connecto',
        language: 'Python',
        url: 'https://github.com/schlegelp/connecto',
      },
      {
        name: 'neuprint-python',
        language: 'Python',
        url: 'https://github.com/connectome-neuprint/neuprint-python',
      },
      { name: 'navis', language: 'Python', url: 'https://github.com/navis-org/navis' },
    ],
    ratherThan: 'Pick this over FlyWire, BANC or Hemibrain unless you need the female brain.',
  },
  {
    key: 'flywire',
    label: 'FlyWire FAFB public',
    backend: 'cave',
    glyph: 'fly_brain',
    tier: 'start',
    clade: 'fly',
    tagline: 'A whole female brain, optic lobes included.',
    specs: {
      specimen: 'Adult female Drosophila',
      region: 'Whole brain (central brain + both optic lobes)',
      neurons: '~140,000',
      completeness: 'Dense',
      resolution: '4 × 4 × 40 nm',
      released: '2024',
    },
    about: `An automated segmentation of the FAFB volume (Zheng et al., 2018), proofread by Princeton, Cambridge and the FlyWire community. Published with a hierarchical annotation set covering super class, class, cell type and side.

Coda reads it through CAVE, so a version is a materialization number: \`783\` matches the Nature paper package and \`630\` the preprint. **New ▸ FlyWire FAFB public** and the Workflow Wizard both open it with the current annotations wired in front of it — the \`flywire_annotations\` repository's hierarchical set with root ids repaired, plus the community annotations as tags — because the annotation table inside the datastack is by now out of date.`,
    strengths: [
      'A whole brain including both optic lobes',
      'Dense annotations from two sources: the hierarchical set & community tags',
      'High synaptic completion rate (fraction of synapses attached to proofread neurons)',
    ],
    caveats: [
      'Brain only — nothing below the neck',
      'CAVE does not support certain queries, e.g. paths or per-region connection counts',
      'High-res skeletons exist only on materialization 783',
    ],
    repositories: [
      {
        name: 'Codex',
        url: 'https://codex.flywire.ai',
        note: 'the published browser — cell type search, circuit summaries, downloads and more',
      },
      {
        name: 'CAVE',
        url: 'https://global.daf-apis.com/info/',
        inCoda: 'FlyWire FAFB public',
        note: 'the datastack Coda queries; segmentation, synapses and meshes',
      },
      {
        name: 'flywire_annotations',
        url: 'https://github.com/flyconnectome/flywire_annotations',
        note: 'the current hierarchical annotations, wired into the workflows by hand',
      },
      {
        name: 'Nature paper package',
        url: 'https://www.nature.com/collections/hgcfafejia',
        note: 'landing page for the FlyWire paper package',
      },
    ],
    citations: [
      {
        text: 'Dorkenwald et al. (2024)',
        url: 'https://doi.org/10.1038/s41586-024-07558-y',
        what: 'the wiring diagram',
        required: true,
      },
      {
        text: 'Schlegel et al. (2024)',
        url: 'https://doi.org/10.1038/s41586-024-07686-5',
        what: 'the annotations',
        required: true,
      },
      {
        text: 'Zheng et al. (2018)',
        url: 'https://doi.org/10.1016/j.cell.2018.06.019',
        what: 'the EM volume',
        required: true,
      },
      {
        text: 'Matsliah et al. (2024)',
        url: 'https://doi.org/10.1038/s41586-024-07981-1',
        what: 'the optic lobe annotations',
      },
      // TODO(facts): FlyWire publishes its own citation guidelines page — link it here rather
      // than trying to reproduce the rules.
    ],
    toolkits: [
      { name: 'fafbseg', language: 'R', url: 'https://github.com/natverse/fafbseg' },
      {
        name: 'connecto',
        language: 'Python',
        url: 'https://github.com/schlegelp/connecto',
      },
      {
        name: 'fafbseg-py',
        language: 'Python',
        url: 'https://github.com/navis-org/fafbseg-py',
      },
      {
        name: 'caveclient',
        language: 'Python',
        url: 'https://github.com/CAVEconnectome/CAVEclient',
      },
    ],
    ratherThan:
      'Pick this over MaleCNS when you need the female brain. If you need a female brain + nerve cord, take a look at the BANC dataset.',
  },
  {
    key: 'minnie65',
    label: 'MICrONS Minnie65 public',
    backend: 'cave',
    glyph: 'mouse_brain',
    tier: 'start',
    clade: 'mouse',
    tagline:
      'A cubic millimetre of mouse visual cortex, with functional recordings from the same neurons.',
    specs: {
      specimen: 'Mouse',
      region: 'Visual cortex, ~1 mm³',
      neurons: '~75,000 with reconstructed morphology', // TODO(facts)
      completeness: 'Dense segmentation, partial proofreading',
      resolution: '8 × 8 × 40 nm', // TODO(facts)
      released: '2025',
    },
    about: `The MICrONS collaboration's cortical volume: a dense EM segmentation of mouse visual cortex, registered to two-photon calcium recordings of the same neurons responding to visual stimuli.`,
    strengths: [
      'Mammalian cortex at synaptic resolution',
      'Structure and function for the same neurons',
    ],
    caveats: [
      'Proofreading is partial (but ongoing) — only a subset of neurons are complete, so connectivity is a lower bound and axons are truncated',
      'A cubic millimetre is a small fraction of one cortical area, so long-range connectivity is absent by construction',
      'Annotations are coarse compared with anything in the fly',
    ],
    repositories: [
      {
        name: 'CAVE',
        url: 'https://global.daf-apis.com/info/',
        inCoda: 'MICrONS Minnie65 public',
      },
      { name: 'MICrONS Explorer', url: 'https://www.microns-explorer.org/' },
    ],
    citations: [
      {
        text: 'The MICrONS Consortium (2025)',
        url: 'https://doi.org/10.1038/s41586-025-08790-w', // TODO(facts): verify
        what: 'the dataset',
        required: true,
      },
    ],
    toolkits: [
      {
        name: 'connecto',
        language: 'Python',
        url: 'https://github.com/schlegelp/connecto',
      },
      {
        name: 'caveclient',
        language: 'Python',
        url: 'https://github.com/CAVEconnectome/CAVEclient',
      },
    ],
  },
  // -------------------------------------------------------------------------
  // Reach for these
  // -------------------------------------------------------------------------
  {
    key: 'hemibrain',
    label: 'Hemibrain',
    backend: 'neuprint',
    glyph: 'fly_hemibrain',
    tier: 'reach',
    clade: 'fly',
    tagline:
      'The first large-scale dense reconstruction of a fly brain, and the template for a lot of subsequent work.',
    specs: {
      specimen: 'Adult female Drosophila',
      region: 'Central brain, roughly one hemisphere',
      neurons: '~25,000 traced (some truncated)',
      completeness: 'Dense within the volume',
      resolution: '8 × 8 × 8 nm',
      released: '2020',
    },
    about: `Janelia FlyEM's reconstruction of approximately half the central brain, extends across the midline to encompass the central complex.  The cell type naming is the vocabulary most later work is written in.`,
    strengths: ['Probably the best-proofread mushroom body and central complex'],
    caveats: [
      'Half a brain, so no bilateral symmetry to check results against',
      'Neurons are truncated at the midline and at the optic lobe boundary, which needs to be taken into account when analysing connectivity, cell counts, morpholoy, etc.',
    ],
    repositories: [
      {
        name: 'neuPrint',
        url: 'https://neuprint.janelia.org',
        inCoda: 'Hemibrain (neuPrint)',
        note: 'v1.2.1 is the current release',
      },
      {
        name: 'Project overview',
        url: 'https://www.janelia.org/project-team/flyem/hemibrain',
      },
    ],
    citations: [
      {
        text: 'Scheffer et al. (2020)',
        url: 'https://doi.org/10.7554/eLife.57443',
        what: 'the connectome',
        required: true,
      },
      {
        text: 'Schlegel et al. (2020)',
        url: 'https://elifesciences.org/articles/66018',
        what: 'shameless plug for our analysis of the hemibrain olfactory system',
        required: false,
      },
      {
        text: 'Hulse et al. (2021)',
        url: 'https://elifesciences.org/articles/66039',
        what: 'THE reference for central complex cell types and circuitry',
        required: false,
      },
    ],
    toolkits: [
      { name: 'hemibrainr', language: 'R', url: 'https://github.com/natverse/hemibrainr' },
      {
        name: 'connecto',
        language: 'Python',
        url: 'https://github.com/schlegelp/connecto',
      },
      {
        name: 'neuprint-python',
        language: 'Python',
        url: 'https://github.com/connectome-neuprint/neuprint-python',
      },
    ],
    ratherThan:
      'Reach for it over MaleCNS when you are reproducing or extending published hemibrain work.',
  },
  {
    key: 'manc',
    label: 'MANC',
    backend: 'neuprint',
    glyph: 'fly_vnc',
    tier: 'reach',
    clade: 'fly',
    tagline:
      'The male adult nerve cord on its own: motor neurons, premotor circuits, and the descending input driving them.',
    specs: {
      specimen: 'Adult male Drosophila',
      region: 'Ventral nerve cord',
      neurons: '~15,800',
      completeness: 'Dense',
      resolution: '8 × 8 × 8 nm',
      released: '2024',
    },
    about: `A dense reconstruction of the male ventral nerve cord from Janelia FlyEM, the Cambridge Drosophila Connectomics Group and Google Connectomics. Motor neurons, the premotor networks driving them, and the descending neurons arriving from the brain are all typed and systematically named.`,
    strengths: [
      'Dense, systematic annotations',
      'High completion rate (fraction of synapses attached to proofread neurons)',
    ],
    caveats: [
      'Nerve cord only — descending/ascending neurons are cut at the neck',
      'Superseded by MaleCNS for new work',
    ],
    repositories: [
      {
        name: 'neuPrint',
        url: 'https://neuprint.janelia.org',
        inCoda: 'MANC (neuPrint)',
        note: 'v1.2.3 is the current release',
      },
      {
        name: 'Project overview',
        url: 'https://www.janelia.org/project-team/flyem/manc-connectome',
      },
      {
        name: 'neuroglancer',
        url: 'https://neuroglancer-demo.appspot.com/#!gs://manc-seg-v1p2/manc-v1.2.3-neuprint-layers.json',
        note: 'the base scene',
      },
    ],
    citations: [
      {
        text: 'Takemura et al. (2024)',
        url: 'https://doi.org/10.7554/eLife.97769.1',
        what: 'the connectome',
        required: true,
      },
      {
        text: 'Marin et al. (2024)',
        url: 'https://doi.org/10.7554/eLife.97766.1',
        what: 'the cell typing and systematic naming',
        required: true,
      },
      {
        text: 'Cheong et al. (2025)',
        url: 'https://doi.org/10.7554/eLife.96084.2',
        what: 'the descending neuron analysis',
      },
    ],
    toolkits: [
      { name: 'malevnc', language: 'R', url: 'https://github.com/natverse/malevnc' },
      {
        name: 'connecto',
        language: 'Python',
        url: 'https://github.com/schlegelp/connecto',
      },
      {
        name: 'neuprint-python',
        language: 'Python',
        url: 'https://github.com/connectome-neuprint/neuprint-python',
      },
    ],
    ratherThan:
      'Reach for this dataset if you want to focus on the ventral nerve cord alone or to confirm results from e.g. the MaleCNS.',
  },
  {
    key: 'banc',
    label: 'BANC public',
    backend: 'cave',
    glyph: 'fly_cns',
    tier: 'reach',
    clade: 'fly',
    tagline:
      'A female whole central nervous system with the neck connective intact — the female counterpart to MaleCNS.',
    specs: {
      specimen: 'Adult female Drosophila',
      region: 'Whole CNS — brain and ventral nerve cord',
      neurons: '~142,000',
      completeness: 'Dense',
      resolution: '4 × 4 × 45 nm',
      released: '2026',
    },
    about: `Brain And Nerve Cord: a complete female central nervous system imaged in one piece, with detailed annotation of the neurons innervating sensory organs, the motor neurons, and the viscera.

Like FlyWire this is a CAVE datastack which limits some of the analysis capabilities.`, // TODO(facts): check the table name and the annotation coverage claim.
    strengths: [
      'Whole CNS in a female fly, which is what makes a sex comparison against MaleCNS possible at all',
      'Intact neck connective, so descending and ascending neurons are complete',
      'Strong peripheral annotation (sensory modality, motor neurons, muscles, biological context, etc)', // TODO(facts)
    ],
    caveats: [
      'Completion rate (fraction of synapses attached to proofread neurons) is generally much lower than in MaleCNS, hemibrain or FlyWire',
      'At the time of writing there are still neurons being proofread in the production datastack',
      'CAVE datastacks do not support certain queries, e.g. paths or per-region connection counts',
      // TODO(facts): which capabilities does Coda decline here? Check `SourceCapabilities`.
    ],
    repositories: [
      {
        name: 'Codex',
        url: 'https://codex.flywire.ai',
        note: 'the primary browser — cell type search, circuit summaries, downloads and more',
      },
      {
        name: 'Project overview',
        url: 'https://banc.community',
        note: 'the landing page for the BANC project',
      },
      // TODO(facts): the GitHub repository the ecosystem post mentions.
    ],
    citations: [
      {
        text: 'Bates et al. (2026)',
        url: 'https://doi.org/10.1038/s41586-026-10735-w',
        what: 'the connectome',
        required: true,
      },
    ],
    toolkits: [
      { name: 'bancr', language: 'R', url: 'https://github.com/flyconnectome/bancr' },
      {
        name: 'connecto',
        language: 'Python',
        url: 'https://github.com/schlegelp/connecto',
      },
      {
        name: 'caveclient',
        language: 'Python',
        url: 'https://github.com/CAVEconnectome/CAVEclient',
      },
    ],
    ratherThan:
      'Reach for it over MaleCNS when the question is about the female, or about sex differences.',
  },
  {
    key: 'catmaid.l1',
    label: 'L1',
    backend: 'catmaid',
    glyph: 'fly_larva',
    tier: 'reach',
    clade: 'fly-larva',
    tagline: 'The first-instar larval central nervous system.',
    specs: {
      specimen: 'First-instar Drosophila larva',
      region: 'Whole CNS — brain to abdominal neuromeres',
      neurons: '5,013 hand-traced',
      completeness: 'Dense in the brain, sparse elsewhere',
      resolution: '3.8 × 3.8 × 50 nm',
      released: '2015 (volume), 2023 (brain connectome)',
    },
    about: `A whole first-instar larval CNS, hand-traced in CATMAID and hosted by Virtual Fly Brain. The brain was reconstructed to completion and published as a full connectome; the rest (SEZ, nerve cord) is traced sparsely.`,
    strengths: [
      'A complete brain connectome of a behaving animal',
      'Rich behavioural and genetic literature tied to identified neurons',
    ],
    caveats: ['Sparse outside the brain'],
    repositories: [
      {
        name: 'CATMAID (Virtual Fly Brain)',
        url: 'https://l1em.catmaid.virtualflybrain.org/',
        inCoda: 'L1 (CATMAID)',
      },
    ],
    citations: [
      {
        text: 'Winding, Pedigo et al. (2023)',
        url: 'https://doi.org/10.1126/science.add9330',
        what: 'the brain connectome',
        required: true,
      },
      {
        text: 'Ohyama, Schneider-Mizell et al. (2015)',
        url: 'https://doi.org/10.1038/nature14297',
        what: 'the EM volume',
        required: true,
      },
    ],
    toolkits: [
      {
        name: 'catmaid (natverse)',
        language: 'R',
        url: 'https://github.com/natverse/rcatmaid',
      },
      { name: 'pymaid', language: 'Python', url: 'https://github.com/navis-org/pymaid' },
    ],
  },

  // -------------------------------------------------------------------------
  // Superseded, but still cited
  // -------------------------------------------------------------------------

  {
    key: 'catmaid.fafb',
    label: 'FAFB',
    backend: 'catmaid',
    glyph: 'fly_brain',
    tier: 'historical',
    clade: 'fly',
    tagline: 'Manually traced neurons in the EM volume that eventually became FlyWire.',
    specs: {
      specimen: 'Adult female Drosophila',
      region: 'Whole brain (volume); reconstructions are sparse',
      neurons: 'A few thousand hand-traced',
      completeness: 'Sparse — traced to answer specific questions',
      resolution: '4 × 4 × 40 nm',
      released: '2018 (volume) + subsequent papers',
    },
    about: `The Female Adult Fly Brain volume, with sparse manual reconstructions in CATMAID from many labs over several years. Coda reads the published subset hosted by Virtual Fly Brain.

Note that while this is the same EM volume as FlyWire, the latter is a re-aligned version of the former, so coordinates will differ somewhat.`,
    strengths: ['Some very high-quality hand-traced neurons (mileage may vary though)'],
    caveats: [
      'Sparse — most of the brain was never traced, so absence of a partner means nothing',
    ],
    repositories: [
      {
        name: 'CATMAID (Virtual Fly Brain)',
        url: 'https://catmaid-fafb.virtualflybrain.org/',
        inCoda: 'FAFB (CATMAID)',
        note: 'the published tracings; an anonymous token is used, so no account is needed',
      },
      { name: 'Virtual Fly Brain', url: 'https://virtualflybrain.org' },
    ],
    citations: [
      {
        text: 'Zheng et al. (2018)',
        url: 'https://doi.org/10.1016/j.cell.2018.06.019',
        what: 'the EM volume',
        required: true,
      },
      // TODO(facts): individual tracing papers are cited per neuron set — CATMAID carries a
      // `publication_link` annotation. Say how to find the right one rather than listing them.
    ],
    toolkits: [
      {
        name: 'catmaid (natverse)',
        language: 'R',
        url: 'https://github.com/natverse/rcatmaid',
      },
      { name: 'pymaid', language: 'Python', url: 'https://github.com/navis-org/pymaid' },
    ],
    ratherThan:
      'This is mostly legacy data at this point. Unless you have very specific reasons to use this, you should reach for FlyWire instead.',
  },
  {
    key: 'opticlobe',
    label: 'Optic Lobe',
    backend: 'neuprint',
    glyph: 'fly_optic',
    tier: 'historical',
    clade: 'fly',
    tagline: 'One optic lobe of the MaleCNS volume, released ahead of the whole thing.',
    specs: {
      specimen: 'Adult male Drosophila',
      region: 'Right optic lobe — medulla, lobula, lobula plate, part of the lamina',
      neurons: '~50,000', // TODO(facts)
      completeness: 'Dense',
      resolution: '8 × 8 × 8 nm',
      released: '2025',
    },
    about: `The right optic lobe of the MaleCNS volume, with parts of the central brain and lamina, published separately and earlier. It carries the visual system cell type inventory the optic lobe papers are written against.

The same tissue is in MaleCNS. Reach for this release when you want the inventory as published.`,
    strengths: [
      'The published visual cell type inventory, with the naming the optic lobe literature uses',
      'Much smaller than MaleCNS, so optic lobe analyses run faster',
    ],
    caveats: [
      'A subset of MaleCNS — anything leaving the optic lobe is cut',
      'Kept mainly as a reference for the papers that used it',
    ],
    repositories: [
      {
        name: 'neuPrint',
        url: 'https://neuprint.janelia.org',
        inCoda: 'Optic Lobe (neuPrint)',
      },
    ],
    citations: [
      {
        text: 'Nern et al. (2025)',
        url: 'https://doi.org/10.1038/s41586-025-08746-0', // TODO(facts): verify
        what: 'the visual system inventory',
        required: true,
      },
    ],
    toolkits: [
      {
        name: 'neuprint-python',
        language: 'Python',
        url: 'https://github.com/connectome-neuprint/neuprint-python',
      },
    ],
    ratherThan: 'Use MaleCNS unless you specifically want this release.',
  },
  {
    key: 'fib19',
    label: 'FIB-19',
    backend: 'neuprint',
    glyph: 'fly_optic',
    tier: 'historical',
    clade: 'fly',
    tagline:
      'An early partial reconstruction of the female visual system, built to work out motion detection.',
    specs: {
      specimen: 'Adult female Drosophila',
      region: 'Portions of medulla, lobula and lobula plate',
      neurons: 'Hundreds', // TODO(facts)
      completeness: 'Dense within a small columnar volume',
      resolution: '8 × 8 × 8 nm',
      released: '2017', // TODO(facts)
    },
    about: `A focused ion beam reconstruction covering a few columns of the fly visual system, made to resolve the circuitry behind elementary motion detection.

Superseded in every respect by the Optic Lobe release and MaleCNS, and kept because the motion detection literature rests on it.`,
    strengths: ['The volume the ON/OFF motion detection circuit papers were built on'],
    caveats: [
      'A few columns, not a visual system — nothing generalises without checking against a complete volume',
    ],
    repositories: [
      { name: 'neuPrint', url: 'https://neuprint.janelia.org', inCoda: 'FIB-19 (neuPrint)' },
    ],
    citations: [
      {
        text: 'Takemura et al. (2017)',
        url: 'https://doi.org/10.7554/eLife.24394', // TODO(facts): verify this is the right paper for FIB-19
        what: 'the reconstruction',
        required: true,
      },
    ],
  },
  {
    key: 'mushroombody',
    label: 'Mushroom Body',
    backend: 'neuprint',
    glyph: 'specimen',
    tier: 'historical',
    clade: 'fly',
    tagline:
      'The alpha lobe of the mushroom body, densely reconstructed — one of the first fly connectomes.',
    specs: {
      specimen: 'Adult male Drosophila',
      region: 'Mushroom body alpha (vertical) lobe',
      neurons: '983',
      completeness: 'Dense within the lobe',
      resolution: '8 × 8 × 8 nm', // TODO(facts)
      released: '2017',
    },
    about: `A dense reconstruction of the alpha lobe, published as one of the first demonstrations that a learning and memory centre could be mapped at synaptic resolution.

983 neurons. It is a structure rather than a brain, and it is here because the mushroom body learning literature cites it.`,
    strengths: [
      'Small enough to hold in your head, and completely reconstructed within its boundary',
    ],
    caveats: [
      'One lobe of one structure — every input and output is cut at the boundary',
      'Both hemibrain and MaleCNS contain the whole mushroom body',
    ],
    repositories: [
      {
        name: 'neuPrint',
        url: 'https://neuprint.janelia.org',
        inCoda: 'Mushroom Body (neuPrint)',
      },
    ],
    citations: [
      {
        text: 'Takemura et al. (2017)',
        url: 'https://doi.org/10.7554/eLife.26975',
        what: 'the reconstruction',
        required: true,
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// What else exists
// ---------------------------------------------------------------------------

/**
 * Connectomes with no node here, and how to get at them anyway.
 *
 * Kept short and kept honest: this is a closing note, not a second catalogue. An entry earns its
 * line by being one a reader of the list above would reasonably expect to find — which is why
 * FANC is here and a C. elegans reconstruction is not.
 *
 * `via` is the load-bearing field. A page that lists a dataset and offers nothing to do about it
 * is an advertisement for a gap; every entry either names the escape-hatch node that opens it or
 * says plainly that nothing here will.
 */
export interface ElsewhereEntry {
  label: string
  /** One sentence: what it is and why somebody looking at this page might want it. */
  what: string
  where: readonly Repository[]
  /**
   * The node that opens it — `Custom CAVE`, `Custom neuPrint`, `Neuroglancer Source` — or a
   * plain statement that Coda cannot read it.
   */
  via: string
}

export const ELSEWHERE: readonly ElsewhereEntry[] = [
  {
    label: 'FANC — female adult nerve cord',
    what: 'The female counterpart to MANC: a dense ventral nerve cord reconstruction, and the nerve cord half of a sex comparison that BANC now also answers.',
    where: [
      { name: 'FANC community', url: 'https://github.com/htem/FANC_auto_recon' },
      { name: 'CAVE', url: 'https://global.daf-apis.com/info/' },
    ],
    via: 'Custom CAVE, naming the datastack and the table that holds neurons. Outside Coda, [connecto](https://github.com/schlegelp/connecto) has a `fanc` handle.', // TODO(facts): give the datastack name and whether the public one is readable without an account.
  },
  {
    label: 'Other neuPrint datasets',
    what: 'Janelia publishes volumes not listed here, including on alternative neuPrint deployments.',
    where: [{ name: 'neuPrint', url: 'https://neuprint.janelia.org' }],
    via: 'Custom neuPrint, naming the deployment and dataset. Everything a built-in neuPrint node does works.',
  },
  {
    label: 'Other CAVE datastacks',
    what: 'CAVE hosts more than the three datastacks with nodes here, including other MICrONS volumes and lab deployments.',
    where: [{ name: 'CAVE global listing', url: 'https://global.daf-apis.com/info/' }],
    via: 'Custom CAVE, naming the datastack and its neuron table.',
  },
  {
    label: 'Your own CATMAID',
    what: 'A lab CATMAID server with your own tracing in it.',
    where: [{ name: 'CATMAID', url: 'https://catmaid.readthedocs.io' }],
    via: 'Custom CATMAID, naming the server and project.',
  },
  {
    label: 'Precomputed volumes',
    what: 'Meshes and skeletons published as a neuroglancer precomputed bucket, with no connectivity behind them — H01 human cortical tissue is one.',
    where: [
      { name: 'H01 release', url: 'https://h01-release.storage.googleapis.com/landing.html' },
    ],
    via: 'Neuroglancer Source, which emits a Dataset the geometry nodes take. Morphology only — nothing that needs a connectivity query will run.',
  },
]
