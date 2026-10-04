/**
 * The changelog: what changed in Coda, for the people who use it.
 *
 * This table is the page. `render.ts` turns it into `changelog.html` at build time, the editor's
 * What's New card reads the entries marked `highlight`, and `scripts/changelog-shots.mjs` captures
 * every image an entry declares. It is written by hand, on purpose: the commits feed a draft,
 * but which changes a reader needs to hear about, and in what words, is an editorial call.
 *
 * ## Writing an entry
 *
 * Newest first, one entry per date. An entry is an *update* — a batch somebody would describe
 * in one sentence — not a week and not a commit, so its date is the day it was written up and
 * each item underneath carries the day it actually landed; the page's timeline draws both.
 *
 * - `summary` is **plain text**: it is what the What's New card shows, and that card renders no
 *   markup. Every other prose field takes the inline markdown `datasetguide/render.ts`' `inline`
 *   allows — `**bold**`, `*italic*`, `` `code` ``, and links to `https://` or `./` only.
 * - `highlight` decides whether the update interrupts anybody. Only a returning reader sees the
 *   card, and only for highlighted updates newer than the last one they saw; everything else
 *   waits on the page, with a dot on the `?` menu.
 * - A `demo` is the tail of a `demo://` link: a bare node type, or
 *   `type/dataset/analysis/view[/rank]` as the node guide prints one. A bare type opens the node's
 *   own demo — hand-written for the nodes in `wizard/curated.ts`, searched for the rest. Demos run
 *   on the synthetic dataset, so they open without an account and reach no server.
 *   `changelog.test.ts` checks each one names a registered node.
 * - A demo whose node has nothing to show on the synthetic dataset is curated on a published one
 *   (`wizard/curated.ts`); its capture names the `signIn` it needs, which `pnpm changelog:shots`
 *   reads from the machine it runs on.
 * - An `image` is a file under `public/changelog/`. Give it a `capture` and
 *   `pnpm changelog:shots` produces it from the running app; the test refuses a declared image
 *   that is not on disk.
 * - Kind `changed` is for a change in behaviour somebody's saved workflow could notice. Say what
 *   the old behaviour was and what to do now.
 *
 * No imports: the editor loads this module with a dynamic `import()`, so it must stay
 * plain data and never pull the registry into the chunk it lands in.
 */

/** What an item is about. Drawn as a shape and a word, never as a colour alone. */
export type ChangeKind = 'node' | 'chart' | 'data' | 'editor' | 'changed'

/**
 * How `pnpm changelog:shots` produces an image: open the editor on the feature's own `demo` (or
 * the first visit's canvas), run it, optionally set params and expand a node or open a dialog, then crop
 * to the dialog that is up — or the whole window if none is. It also writes a small
 * thumbnail beside the image (`images.ts`), which is what the What's New card draws.
 */
export interface Capture {
  /**
   * Params to set before the run, on the first node of each type named. A `demo://` link cannot
   * carry params, so **Open example** opens the node on its defaults: a feature whose picture
   * needs a param should say in its body how to set it.
   */
  params?: readonly { type: string; param: string; value: string | number | boolean }[]
  /** Expand the first node of this type into the full-size viewer. */
  expand?: string
  /** A store action taking no arguments, e.g. `openPlugins` or `openWhatsNew`. */
  open?: string
  /**
   * The credential the demo needs, handed to the page before it opens — for a demo curated on a
   * published dataset. `pnpm changelog:shots` reads it from the machine it runs on (see that
   * script), never prints it, and skips the shot where there is none.
   */
  signIn?: 'cave'
}

export interface ChangelogImage {
  /** File name under `public/changelog/`. */
  file: string
  alt: string
  capture?: Capture
}

/** A change given a card of its own, with room for an image and a way to try it. */
export interface ChangelogFeature {
  kind: ChangeKind
  /** The day it landed, `YYYY-MM-DD`; on or before its entry's date. */
  date: string
  title: string
  /** Blank-line-separated paragraphs of inline markdown. */
  body: string
  image?: ChangelogImage
  /** Opened by **Open example**, and the workflow the image's `capture` is taken on. */
  demo?: string
  /** Any other link, on-site (`./…`) or off. */
  link?: { href: string; label: string }
}

/** A change given one line, and at most a sentence or two under it. */
export interface ChangelogItem {
  kind: ChangeKind
  date: string
  /** Inline markdown. */
  title: string
  /** Inline markdown. */
  body?: string
  demo?: string
}

export interface ChangelogEntry {
  /** `YYYY-MM-DD`, unique. Also the entry's anchor on the page. */
  date: string
  title: string
  /** Plain text. One or two sentences; the What's New card shows it verbatim. */
  summary: string
  highlight: boolean
  features?: readonly ChangelogFeature[]
  items?: readonly ChangelogItem[]
  /** Inline markdown, one fix per string. */
  fixes?: readonly string[]
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    date: '2026-10-04',
    title: 'A cell typing pack, and a scatter plot to explore embeddings',
    summary:
      'A new Cell typing/annotation tools pack: open a BigClust project, explore it in a Scatter Plot that now names, searches and re-embeds its points, and write the cell types you settle on back to FlyTable or Clio.',
    highlight: true,
    features: [
      {
        kind: 'node',
        date: '2026-10-04',
        title: 'A pack for cell typing and annotation',
        body:
          'The new **Cell typing/annotation tools** pack brings two nodes for typing neurons: one to explore a co-clustering, one to record what you decide. It is off by default: switch it on under **Plugins**.\n\n' +
          '**BigClust Project** reads a [BigClust](https://github.com/schlegelp/BigClust2) project, from a URL or a folder on your disk: its neurons, the coordinates of one embedding, that embedding’s k-nearest-neighbour graph and its feature vectors, each as a table. Pick the embedding in the card; for several side by side, use a node each and **Join** them on `neuronId`. Its **Scene** output is the project’s own neuroglancer scene: wire it into a **Neuroglancer** node with a selection, and the selected neurons are drawn in their own volumes and colours. To try it, paste `https://flyem.mrc-lmb.cam.ac.uk/flyconnectome/bigclust_data/examples/MaleCNS_FlyWire_hemibrain_central_brain_bigclust`, BigClust’s own example: male CNS, FlyWire and hemibrain central-brain neurons, co-clustered.\n\n' +
          '**Annotate** takes a selection — a lasso on a Scatter Plot, a table of ids — and reads those neurons’ rows from a FlyTable or SeaTable table, their annotations from a Clio dataset, or their rows from a CSV file on your computer (edited in place; Chrome and Edge only). **Fields** picks which columns to show. Editing a cell writes it straight back; **Undo** writes the previous values back, and **Log** downloads every edit the card made. Before writing, the card reads each cell again, so a cell somebody else changed since you saw it is held and marked rather than overwritten, and a value the column cannot hold is refused before anything is sent.\n\n' +
          'Tick rows and use **Set … to …** to give many neurons one value at once. Add a tab per table with **+**: a selection mixing datasets, as a BigClust project does, is split between the tabs by qualified id or a dataset column, and the card counts any neuron no tab takes. Cells you change are marked until you undo them. On Clio, a tab can show bodies nobody has annotated yet as empty rows, and keep `instance` in step with `type`; both are off until you switch them on. Writing needs an account on the table: add your FlyTable or Clio token under **Connections**.',
        link: { href: 'https://github.com/schlegelp/BigClust2', label: 'BigClust on GitHub' },
        // Taken from BigClust's example project over the network, with a selection made by hand: no
        // `capture`, so `pnpm changelog:shots` leaves it alone.
        image: {
          file: 'bigclust.webp',
          alt: 'BigClust’s example project feeding a Scatter Plot of its 87,263 neurons, ten of them selected, and a Neuroglancer card drawing those ten in the male CNS brain.',
        },
      },
      {
        kind: 'chart',
        date: '2026-10-02',
        title: 'Names, a search and your own tooltip on the Scatter Plot',
        body:
          'Tick **Labels on points** and each point is named beside it once few enough are in view (400 by default), placed so labels cover neither each other nor other points. **Hover shows** adds the columns you pick to the tooltip.\n\n' +
          'On the expanded card, **⌕** opens a search: matches are outlined, **‹ ›** step through them, and **◎** selects them all (Shift adds them to the selection). The **⋯** menu searches one column instead, or matches whole values, case or a regular expression.',
        demo: 'out.scatter',
      },
    ],
    items: [
      {
        kind: 'editor',
        date: '2026-10-04',
        title: 'See what Coda keeps in your browser.',
        body: 'Click **Memory** in the status bar and open the new **Storage** tab. It lists downloaded data, saved workflows, recipes, uploads and sign-ins, each with its size, and **Clear** empties the downloaded data.',
      },
      {
        kind: 'node',
        date: '2026-10-02',
        title: '**Embedding** lays out part of a population.',
        body: 'Wire a selection into its new **Only these** input to re-embed just those neurons, from a matrix, a feature table or a k-NN graph. For example, lasso a group of points on one embedding and embed just that group.',
        demo: 'core.embed',
      },
      {
        kind: 'editor',
        date: '2026-10-01',
        title: 'Large selections stay in the autosave.',
        body: 'A lasso of a hundred thousand neurons is now saved about six times smaller, so it fits in the browser’s autosave and in share links. Workflows saved before open as they did.',
      },
      {
        kind: 'editor',
        date: '2026-10-02',
        title: 'Tighter dashboards.',
        body: 'Less space between the cells of a dashboard, so the charts get more of the screen.',
      },
      {
        kind: 'chart',
        date: '2026-10-02',
        title: 'No bounding boxes in **Neuroglancer** scenes.',
        body: 'Scenes opened by Coda no longer draw a box around the whole volume. On a small card, the box was most of what you saw.',
      },
      {
        kind: 'chart',
        date: '2026-10-02',
        title: 'The **Network Viewer**’s Find takes the same search as the Scatter Plot.',
        body: 'Start a term with `/` to search by regular expression.',
      },
    ],
    fixes: [
      'A large table file read from a URL no longer fails over one dropped connection: the read is retried. If the server keeps dropping the connection, the error now says so instead of blaming cross-origin access.',
    ],
  },
  {
    date: '2026-10-01',
    title: 'Dashboards with tabs',
    summary:
      'Build several dashboards from one workflow: an overview, a page of tables, a page of 3D views, each with its own grid.',
    highlight: false,
    features: [
      {
        kind: 'editor',
        date: '2026-10-01',
        title: 'Tabs on the dashboard',
        body:
          'Press **+** beside the dashboard’s title to add a page. Each tab has its own cells and its own number of columns, and a node can sit on as many tabs as you like. Double-click a tab to rename it; right-click it to duplicate, move or delete it.\n\n' +
          'On the canvas, right-click a card and pick which tabs it goes on. A workflow saved from the dashboard opens on the tab it was saved from.',
        // Taken by hand from the running app: a capture can only crop to a dialog or the whole
        // window, and the subject here is one bar.
        image: {
          file: 'dashboard-tabs.webp',
          alt: 'The dashboard’s bar with three tabs — Overview, Partners and Tables — a + to add another, and the column slider, Add node and Canvas buttons on the right.',
        },
      },
    ],
    items: [
      {
        kind: 'chart',
        date: '2026-10-01',
        title: '**Scatter Plot** draws every point, however many',
        body: 'An embedding of a whole dataset — a hundred thousand neurons and more — now draws in full and pans smoothly, so `Max points` is gone. Exported, more than 10,000 points in view become one embedded image inside the SVG; tick **Vector marks** to keep every point a shape.',
        demo: 'out.scatter',
      },
    ],
  },
  {
    date: '2026-09-30',
    title: 'Your own connectome, from your own files',
    summary:
      'Assemble a dataset from your own tables and files, and query it with the same nodes you use on a published one. Parquet and Feather files of any size are read where they are, never loaded whole.',
    highlight: true,
    features: [
      {
        kind: 'node',
        date: '2026-09-30',
        title: 'Custom Dataset: a connectome from parts',
        body:
          'Wire in whichever parts you have: a neuron table, an edge list, a synapse table, and meshes or skeletons borrowed from any other dataset (a Neuroglancer Source, neuPrint, CAVE). **Find Neurons**, **Explore Dataset**, **Connectivity**, **Paths**, **Synapses** and the rest then work on it as on a published dataset.\n\n' +
          'With a synapse table and no edge list, connectivity is counted from the synapses. **Open example** builds one out of the synthetic connectome; swap any part for your own.',
        // Taken from a FlyWire workflow on local files, which no capture can reproduce: no
        // `capture`, so `pnpm changelog:shots` leaves it alone.
        image: {
          file: 'custom-dataset.webp',
          alt: 'A Custom Dataset assembled from FlyWire parts: a cell-type table as Neurons, two Link Table files as the edge list and the 192-million-row synapse table, and a Neuroglancer Source lending meshes and skeletons. Explore Dataset lists its neurons, and a Synapses node returns 124,747 synapses for the 25 selected.',
        },
        demo: 'connectome:customDataset',
      },
      {
        kind: 'node',
        date: '2026-09-30',
        title: 'Link Table and Read Rows: files too large to load',
        body:
          '**Link Table** points at a Parquet or Feather file, on your disk or at a URL, and reads only its footer, so its columns are in every picker below it at once. **Read Rows** pulls out the columns and the rows you ask for, for example by neuron id, and a Custom Dataset reads its Edges and Synapses from a Link Table the same way.\n\n' +
          'A lookup of a few neurons in a 190-million-row synapse table takes about a second when the file is sorted by the id column. In Chrome and Edge a local file comes back after a reload; in other browsers you choose it again. It also takes the URL of a Delta Lake table’s folder, such as CAVE’s exports.',
      },
    ],
    items: [
      {
        kind: 'node',
        date: '2026-09-30',
        title: '**Filter Table** works on a Link Table file.',
        body: 'Between a Link Table and whatever reads it, it drops rows as they are read, a confidence threshold on a synapse file for example, without scanning the whole file.',
      },
      {
        kind: 'data',
        date: '2026-09-30',
        title: 'Notebook export for the new nodes.',
        body: 'A Python notebook exported from a workflow with a Custom Dataset reads the same files with pyarrow. The R export does not cover them yet.',
      },
    ],
  },
  {
    date: '2026-09-26',
    title: 'Laminar profiles, and Cortex in the Workflow Wizard',
    summary:
      'See where a neuron’s synapses land against the cortical layers, split by partner type. The Cortex Gallery and the new profile are now in the Workflow Wizard.',
    highlight: true,
    features: [
      {
        kind: 'node',
        date: '2026-09-26',
        title: 'Laminar Profile: synapses against the layers',
        body:
          'Two new nodes in the **Cortex** plugin. **Cortical Depth** takes coordinates (typically synapses) and assigns each its depth below the pia and its layer. **Laminar Profile** draws that depth with the layers marked behind it.\n\n' +
          'Facet the profile to compare e.g. partner types, and click a bar or a layer’s share to pass those synapses on. ' +
          'Works on MICrONS minnie65. **Open example** loads three cells whose inputs sit in different layers; it needs a CAVE sign-in.',
        image: {
          file: 'laminar-profile.webp',
          alt: 'Laminar Profile of three MICrONS cells, one panel per cell type: each panel shows where the cell’s input synapses sit against the cortical layers, split by partner type.',
          capture: { expand: 'cortex:laminarProfile', signIn: 'cave' },
        },
        // The node's own curated demo (`wizard/curated.ts`): three minnie65 cells whose inputs
        // sit in different layers, one panel per type — what the node guide and `?` open too.
        demo: 'cortex:laminarProfile',
      },
      {
        kind: 'editor',
        date: '2026-09-26',
        title: 'Cortex in the Workflow Wizard',
        body: 'With the Cortex plugin switched on, **Cortex Gallery** and **Laminar synapse profile** show up as options in the Workflow Wizard.',
        link: { href: './cortex/', label: 'Open Coda with Cortex switched on' },
      },
    ],
    items: [
      {
        kind: 'node',
        date: '2026-09-26',
        title: 'Skeleton to Points.',
        body: 'Turns skeletons into a point cloud, with one point per piece of cable at a spacing you choose. Each point carries its neuron, compartment (where the source labels one), cable, radius, Strahler order and distance to root. Feed it to **Cortical Depth** and **Laminar Profile** to see where an arbour sits in the layers, or to **Points in Volumes** for cable per region.',
        demo: 'neuron.skeletonPoints',
      },
      {
        kind: 'data',
        date: '2026-09-26',
        title: 'CAVE table reads views.',
        body: 'The `CAVE table` node now lists views as well as tables, along with their columns. A bare MICrONS Minnie65 node now has a button that adds the recommended cell-type annotations.',
      },
    ],
    fixes: [
      'Pinch-to-zoom works over widgets that scroll, and zooming a Cortex Gallery card is smoother.',
      'A chart that first had nothing to draw (a Sankey before its columns are picked, say) now draws once it has, instead of staying blank until reopened.',
      'The tallest bar of a Histogram or Bar Chart no longer runs past the top of its axis.',
      'Charts with a selection no longer redraw on every edit elsewhere in the graph, or while their card is dragged.',
    ],
  },
  {
    date: '2026-09-25',
    title: 'Plugins, Recipes and a changelog',
    summary:
      'Dynamically extend functionality, save sets of nodes you use often, and get informed when new features land.',
    highlight: true,
    features: [
      {
        kind: 'editor',
        date: '2026-09-25',
        title: 'Coda grew a Changelog',
        body:
          'A chronological list of all changes to Coda. Where a change can be tried, **Open example** loads a working workflow in the editor.\n\n' +
          'When a new feature drops, Coda shows a short note the next time you open it. You can find the note again under **? ▸ What’s New**.',
        image: {
          file: 'whats-new.webp',
          alt: 'The What’s New card in the corner of the editor, listing a recent update with a link to the changelog.',
          capture: { open: 'openWhatsNew' },
        },
      },
      {
        kind: 'editor',
        date: '2026-09-24',
        title: 'Plugins: making Coda modular',
        body:
          'Nodes are now organised into plugins. The initial set includes Connectome, ZapBench and Cortex. Switch off the ones you don’t use under **⋯ ▸ Plugins**. Workflows that already use them still open and run.\n\n' +
          'In the future, selecting sets of plugins will allow you to fully customise Coda to your specific needs.\n\n' +
          'The first new plugin is **Cortex**, with the **Cortex Gallery** for browsing MICrONS cells by type and cortical depth. Go to `coda.science/cortex` to open Coda with it switched on.',
        image: {
          file: 'plugins.webp',
          alt: 'The Plugins dialog, listing Connectome, neuPrint, CAVE, CATMAID and ZapBench, each with its nodes and an on/off switch.',
          capture: { open: 'openPlugins' },
        },
        link: { href: './cortex/', label: 'Open the Cortex Gallery' },
      },
    ],
    items: [
      {
        kind: 'editor',
        date: '2026-09-23',
        title: 'Recipes.',
        body: 'Select a set of nodes, right-click ▸ **Save as Recipe…**. The recipe can then be added to any workflow via the **+** button, the command palette or the context menu.',
      },
      {
        kind: 'data',
        date: '2026-09-25',
        title: 'FlyWire nodes warn about outdated cell types.',
        body: 'A `FlyWire FAFB` node on its own uses cell-type labels that have since been updated. The node now says so and offers a one-click fix that adds the current annotation tables.',
      },
      {
        kind: 'data',
        date: '2026-09-22',
        title: 'CAVE tables are easier to set up.',
        body: 'The `CAVE table` node’s settings are simpler, and CAVE neuron thumbnails load more reliably.',
      },
      {
        kind: 'data',
        date: '2026-09-25',
        title: 'MICrONS connectivity now uses an aggregated view.',
        body: 'This speeds up all connectivity queries.',
      },
      {
        kind: 'node',
        date: '2026-09-25',
        title: 'Improved CAVE node configuration.',
        body: '`Custom CAVE` now lets you change the default synapse table and other settings.',
      },
      {
        kind: 'node',
        date: '2026-09-24',
        title: 'ROI Meshes works with numbered regions.',
        body: 'Sources that publish region IDs but no names can now be drawn.',
      },
    ],
    fixes: [
      'The workflow list under **Open** now scrolls when it is long.',
      'Hovering a **CAVE table** output now shows its contents.',
      'The Recipes dialog handles a long list of recipes.',
    ],
  },
  {
    date: '2026-09-21',
    title: 'Three new charts, and new nodes for synapses',
    summary:
      'Sankey, Flow Chart and Rank Plot show how signals move through a circuit, and new nodes find, place and count synapses.',
    highlight: true,
    features: [
      {
        kind: 'chart',
        date: '2026-09-19',
        title: 'Sankey: where a signal goes, layer by layer',
        body: 'Connect an **Influence** node’s Transfers output and see how drive spreads from your seed neurons through each layer. The caption tells you how far the diagram is from conserving flow, because synapse counts usually don’t.',
        image: {
          file: 'sankey.webp',
          alt: 'Sankey diagram of influence flowing from lamina neurons through medulla types to lobula outputs.',
          capture: { expand: 'out.sankey' },
        },
        demo: 'out.sankey/mock.opticlobe/influence/sankey',
      },
      {
        kind: 'chart',
        date: '2026-09-19',
        title: 'Flow Chart: a circuit you can read',
        body: 'Boxes sized to their labels, arrows routed around them, and a synapse count on every arrow. Built for the tens of neurons a **Paths** search returns, where the Network Viewer is built for thousands. Feedback connections are drawn dashed so they are not mistaken for feed-forward ones.',
        image: {
          file: 'flow-chart.webp',
          alt: 'Flow chart of cell types in three columns, with weighted arrows from L1, L2 and Tm9 through Mi1, Tm1 and Tm3 to T4 and T5.',
          capture: {
            expand: 'out.flowChart',
          },
        },
        demo: 'out.flowChart/mock.opticlobe/paths/flowChart',
      },
      {
        kind: 'chart',
        date: '2026-09-19',
        title: 'Rank Plot: for measures with a long tail',
        body: 'Scores on a log axis by rank, with the running share of the total underneath, so you can see how many neurons account for most of an influence score. Seed neurons are ringed and left out of the share.',
        image: {
          file: 'rank-plot.webp',
          alt: 'Rank plot of influence scores on log–log axes, with the top-ranked cell types labelled.',
          capture: { expand: 'out.rank' },
        },
        demo: 'out.rank/mock.opticlobe/influence/rank',
      },
      {
        kind: 'chart',
        date: '2026-09-19',
        title: 'Heatmap circles',
        body: 'Set **Cell shape** to circles and each cell’s size shows its value as well as its colour. On a sparse matrix the pattern stands out, because empty cells stay blank.',
        image: {
          file: 'heatmap-circles.webp',
          alt: 'A connectivity heatmap drawn with circles whose size follows the value, leaving empty cells blank.',
          capture: {
            params: [{ type: 'out.heatmap', param: 'cellShape', value: 'circle' }],
            expand: 'out.heatmap',
          },
        },
        demo: 'out.heatmap/mock.opticlobe/matrix/heatmap',
      },
    ],
    items: [
      {
        kind: 'node',
        date: '2026-09-19',
        title: 'New: `NeuronBridge`.',
        body: 'Find the light-microscopy lines that match an EM neuron, using Janelia’s NeuronBridge index. You can also choose it as an analysis in the Workflow Wizard.',
      },
      {
        kind: 'node',
        date: '2026-09-19',
        title: 'New: `Select Neurons`.',
        body: 'Pick neurons out of a set by rules on their attributes.',
        demo: 'neuron.selectNeurons',
      },
      {
        kind: 'node',
        date: '2026-09-17',
        title: 'New nodes: `Synapses Between` and `Synapses to Edges`.',
        body: 'Get the synapses between two sets of neurons, then count them into an edge list, optionally split by region.',
        demo: 'neuron.synapsesBetween',
      },
      {
        kind: 'node',
        date: '2026-09-17',
        title: 'New: `Points in Volumes`.',
        body: 'Label each synapse with the brain region, or any mesh, it sits inside.',
        demo: 'neuron.pointsInVolumes',
      },
      {
        kind: 'node',
        date: '2026-09-18',
        title: 'New: `Distance between` (preview).',
        body: 'The closest approach, mean or median distance between skeletons and meshes.',
        demo: 'neuron.distance',
      },
      {
        kind: 'node',
        date: '2026-09-17',
        title: 'New: `Upload Mesh`.',
        body: 'Bring your own OBJ, PLY or STL into the 3D View.',
      },
      {
        kind: 'data',
        date: '2026-09-21',
        title: 'Sign in to neuPrint from Coda.',
        body: 'A sign-in window replaces copying a token from the neuPrint website.',
      },
      {
        kind: 'data',
        date: '2026-09-17',
        title: 'Large meshes draw in Firefox.',
        body: '**Meshes** also has an explicit **Downsample** setting. Full resolution is the default.',
      },
      {
        kind: 'node',
        date: '2026-09-19',
        title: 'Normalised weights.',
        body: 'Connection weights can be divided by each neuron’s total input or output, and **Paths** reports how many neurons each step covers.',
      },
      {
        kind: 'editor',
        date: '2026-09-17',
        title: 'Use Coda from your AI assistant.',
        body: 'The [Coda MCP server](./mcp.html) lets Claude and other assistants build workflows for you and hand back a link that opens them.',
      },
      {
        kind: 'editor',
        date: '2026-09-16',
        title: 'Node descriptions on hover.',
        body: 'The node browser describes each node as you hover it, and warning messages across nodes are clearer.',
      },
    ],
    fixes: [
      'Heatmap rows are ordered correctly when labels are supplied.',
      'Graphene meshes load completely.',
      'The NeuronBridge Download button is no longer clipped.',
      'Explore Dataset lays out correctly when narrow.',
      '**ROI Meshes** works with a Neuroglancer source as input.',
    ],
  },
  {
    date: '2026-09-14',
    title: 'From zebrafish activity to connectivity',
    summary:
      'ZapBench calcium recordings can now be joined to connectome neurons, and the editor shows more about what is on each wire.',
    highlight: false,
    items: [
      {
        kind: 'data',
        date: '2026-09-13',
        title:
          'New nodes: `Cell IDs`, `ZapBench Traces`, `ZapBench to Neurons` and `Neurons to ZapBench Traces`.',
        body: 'Read whole-brain calcium activity from the larval zebrafish, and go from its cells to connectome neurons and back.',
      },
      {
        kind: 'node',
        date: '2026-09-08',
        title: 'New: `Embedding`.',
        body: 'UMAP of a feature or similarity matrix, reproducible with a fixed seed.',
        demo: 'core.embed',
      },
      {
        kind: 'node',
        date: '2026-09-13',
        title: 'New nodes: `Reduce Matrix` and `Attach Attributes`.',
        body: 'Collapse a matrix to one value per row or column (mean, sum, spread), and add columns from a table to skeletons or meshes.',
        demo: 'core.reduceMatrix',
      },
      {
        kind: 'editor',
        date: '2026-09-09',
        title: 'Hover an output to preview it.',
        body: 'After a run, hovering a node’s output socket shows what it holds: columns, a row, the size.',
      },
      {
        kind: 'editor',
        date: '2026-09-13',
        title: 'Hints on nodes.',
        body: 'Attach a short note to any node for whoever opens the workflow next.',
      },
      {
        kind: 'editor',
        date: '2026-09-09',
        title: 'Screen Map.',
        body: 'A new guide under **? ▸ Guides** labels every control on screen at once.',
      },
      {
        kind: 'chart',
        date: '2026-09-11',
        title: 'Selecting in the 3D View.',
        body: 'Click a mesh to select it; unselected neurons fade. Skeletons are drawn at their real thickness.',
      },
      {
        kind: 'chart',
        date: '2026-09-10',
        title: 'Heatmap selection and labels.',
        body: 'Select rows and columns by dragging, and rename axis labels, for example from IDs to cell types.',
      },
      {
        kind: 'node',
        date: '2026-09-09',
        title: 'A richer Explore Dataset.',
        body: 'Animated thumbnails on hover, small distribution plots, and a guide for the expanded view.',
      },
      {
        kind: 'data',
        date: '2026-09-11',
        title: 'Other CAVE deployments.',
        body: '**Custom CAVE** can point at any CAVE server, not only the public ones.',
      },
      {
        kind: 'chart',
        date: '2026-09-11',
        title: 'Network Viewer to Cytoscape.',
        body: 'Open the graph in Cytoscape Web with one click.',
      },
      {
        kind: 'editor',
        date: '2026-09-11',
        title: 'Memory readout.',
        body: 'The status bar shows how much memory Coda is using, and the top-left menu can **Clone** and **Rename** workflows.',
      },
      {
        kind: 'editor',
        date: '2026-09-08',
        title: 'Phones and small screens.',
        body: 'The toolbar folds into a menu instead of zooming the whole page out.',
      },
    ],
    fixes: [
      'Very thin neurons now get a thumbnail in Explore Dataset.',
      'Clearer error when a CAVE service is likely down.',
      'Collapsed groups line up correctly.',
      'Synapse points in the 3D View are drawn at a visible size by default (800 nm).',
    ],
  },
  {
    date: '2026-09-07',
    title: 'Compare connectomes from the Wizard',
    summary:
      'The Workflow Wizard can build one workflow over several datasets at once, and every node guide entry opens a working example.',
    highlight: false,
    features: [
      {
        kind: 'editor',
        date: '2026-09-07',
        title: 'Multi-dataset comparisons in the Workflow Wizard',
        body: 'Choose two or more connectomes in the Wizard’s first question and it builds one workflow that stacks them, offering only the analyses every chosen dataset supports. Generated workflows are laid out automatically and carry a note explaining each step.',
        image: {
          file: 'wizard.webp',
          alt: 'The Workflow Wizard’s first question, listing the connectomes to build a workflow on.',
          capture: { open: 'openWizard' },
        },
      },
    ],
    items: [
      {
        kind: 'node',
        date: '2026-09-07',
        title: 'New: `Split Neurons`.',
        body: 'Divide skeletons or meshes into two groups by a rule, with **Carry fields** to bring any column along.',
        demo: 'neuron.splitNeurons',
      },
      {
        kind: 'node',
        date: '2026-09-07',
        title: '**Stack Tables** and **Stack Neurons** take any number of inputs.',
      },
      {
        kind: 'chart',
        date: '2026-09-05',
        title: 'Dendrogram zoom and labels.',
        body: 'Zoom and pan, and rename leaves from an annotation table.',
        demo: 'out.dendrogram/mock.opticlobe/cluster/dendrogram',
      },
      {
        kind: 'node',
        date: '2026-09-05',
        title: '**Neuron Profile** groups by any column.',
        body: 'Including cell type, so a profile can describe a whole type rather than one neuron.',
      },
      {
        kind: 'editor',
        date: '2026-09-06',
        title: 'Examples in the Node Guide.',
        body: 'Every entry has **Open in a workflow** and a **See also** list.',
      },
      {
        kind: 'editor',
        date: '2026-09-06',
        title: 'Dashboard progress.',
        body: 'The Dashboard shows a progress bar while it runs, and **⌘A** selects every node.',
      },
      {
        kind: 'editor',
        date: '2026-09-07',
        title: 'AI assistant modes.',
        body: 'A lean mode and a reasoning mode, and a **Send run values** switch for keeping results out of the conversation.',
      },
      {
        kind: 'changed',
        date: '2026-09-06',
        title: 'Find Neurons with no filter now returns no neurons.',
        body: 'It used to return the whole dataset, which could start a very large query as soon as the node was dropped on the canvas. Add a filter or a region to get neurons back. Saved workflows that relied on the old behaviour will show an empty table.',
      },
      {
        kind: 'changed',
        date: '2026-09-07',
        title: 'Neuron IDs are always text.',
        body: 'Every data source now publishes `neuronId` as text rather than a number. Long CAVE IDs no longer lose digits, and neuPrint and CAVE tables can be stacked together. If you export a table and join it elsewhere, the ID column type has changed.',
      },
    ],
    fixes: [
      'Reloading while in the Dashboard no longer marks results as stale.',
      'Right-clicking the selection rectangle opens the right menu.',
      '**Table from URL** accepts GitHub file links.',
      'Unlit synapses in **Neuron Topology** are drawn with the right transparency.',
      'Collapsed groups show when a member is running or has failed.',
      'Corrected descriptions for BANC and maleCNS.',
    ],
  },
  {
    date: '2026-09-01',
    title: 'Coda is public',
    summary:
      'Coda opens to everyone as a public beta: a node-graph editor for connectome analysis that runs in your browser.',
    highlight: false,
    features: [
      {
        kind: 'editor',
        date: '2026-09-01',
        title: 'Connectome analysis, as a graph you can see',
        body:
          'Wire nodes together to query a connectome, reshape the answer and draw it: partners, paths, influence, morphology and more, over neuPrint, CAVE and CATMAID datasets. Nothing to install; it runs in your browser.\n\n' +
          'New to it? The **Workflow Wizard** builds a first workflow from four questions, the [field guide](./tutorial.html) explains the ideas, and the [node guide](./nodes.html) describes every node.',
        link: { href: './overview.html', label: 'Read the overview' },
      },
    ],
  },
]
