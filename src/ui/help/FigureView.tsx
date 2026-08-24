/**
 * Draw a figure model.
 *
 * Thin on purpose: everything that could be got wrong — which sockets a node has, what its
 * settings default to, where the cards go, what shape a wire takes — was decided in
 * `src/help/figures.ts`, which is headless and therefore tested. What is left here is turning a
 * model into elements, and the reason that split exists is the node guide page: it has no React,
 * and when it grows figures it needs a second renderer rather than a second layout engine.
 *
 * Positions are inline styles rather than classes because they *are* data. The stylesheet
 * (`src/help/figure.css`) owns every colour and no coordinate.
 */

import '../../help/figure.css'

import type { FigureCard, FigureGraph, FigureParams, HelpFigure } from '../../help/figures'

export function FigureView({ figure }: { figure: HelpFigure }) {
  return figure.kind === 'params' ? (
    <ParamsFigure figure={figure} />
  ) : (
    <GraphFigure figure={figure} />
  )
}

function GraphFigure({ figure }: { figure: FigureGraph }) {
  return (
    <div className="cfig">
      <div
        className="cfig__stage"
        style={{ width: figure.width, height: figure.height }}
        role="img"
        aria-label={figure.caption ?? describe(figure)}
      >
        <svg
          className="cfig__wires"
          width={figure.width}
          height={figure.height}
          aria-hidden="true"
        >
          {figure.wires.map((wire, i) => (
            <path key={i} className="cfig__wire" data-fam={wire.family} d={wire.path} />
          ))}
        </svg>
        {figure.cards.map((card) => (
          <Card key={card.alias} card={card} />
        ))}
      </div>
      {figure.caption && <p className="cfig__caption">{figure.caption}</p>}
      <Problems problems={figure.problems} />
    </div>
  )
}

/**
 * What a screen reader is told about a figure with no caption.
 *
 * A pipeline read out as a sentence, because the thing a figure carries that the prose around it
 * often does not is the *order* — and a list of card labels with no arrows between them would be
 * exactly the part that fails to survive.
 */
function describe(figure: FigureGraph): string {
  if (figure.cards.length === 0) return 'An empty figure'
  const byAlias = new Map(figure.cards.map((c) => [c.alias, c.label]))
  const links = figure.wires.map(
    (w) => `${byAlias.get(w.from) ?? w.from} into ${byAlias.get(w.to) ?? w.to}`,
  )
  const nodes = figure.cards.map((c) => c.label).join(', ')
  return links.length ? `${nodes}. Wired: ${links.join('; ')}` : nodes
}

function Card({ card }: { card: FigureCard }) {
  const rows = Math.max(card.inputs.length, card.outputs.length)
  return (
    <div
      className="cfig__card"
      data-category={card.category}
      data-backend={card.backend}
      data-focus={card.focus || undefined}
      style={{ left: card.x, top: card.y, width: card.width, height: card.height }}
    >
      <div className="cfig__head">{card.label}</div>
      {rows > 0 && (
        <div className="cfig__band">
          {Array.from({ length: rows }, (_, i) => {
            const input = card.inputs[i]
            const output = card.outputs[i]
            return (
              <div className="cfig__row" key={i}>
                <span className="cfig__side">
                  {input && (
                    <>
                      <span
                        className="cfig__pip"
                        data-fam={input.family}
                        data-shape={input.shape}
                        data-req={input.required}
                        title={`${input.label}: ${input.type}`}
                      />
                      <span className="cfig__port-label">{input.label}</span>
                    </>
                  )}
                </span>
                <span className="cfig__side cfig__side--out">
                  {output && (
                    <>
                      <span className="cfig__port-label">{output.label}</span>
                      <span
                        className="cfig__pip"
                        data-fam={output.family}
                        data-shape={output.shape}
                        data-req={true}
                        title={`${output.label}: ${output.type}`}
                      />
                    </>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {card.params.length > 0 && (
        <div className="cfig__band">
          {card.params.map((param) => (
            <div className="cfig__param" key={param.id} data-called={param.called || undefined}>
              <span className="cfig__param-label">{param.label}</span>
              <span className="cfig__param-value">
                {param.value}
                {param.picker ? ' ▾' : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {card.more > 0 && <div className="cfig__more">… {card.more} more</div>}
    </div>
  )
}

function ParamsFigure({ figure }: { figure: FigureParams }) {
  return (
    <div className="cfig-params">
      {figure.rows.map((row) => (
        <div className="cfig-params__row" key={row.id}>
          <div className="cfig-params__name">{row.label}</div>
          <div className="cfig-params__meta">
            {row.kind}
            {' · default '}
            {row.value}
            {row.advanced && ' · inspector only'}
          </div>
          {row.help && <div className="cfig-params__help">{row.help}</div>}
        </div>
      ))}
      {figure.caption && <p className="cfig__caption">{figure.caption}</p>}
      <Problems problems={figure.problems} />
    </div>
  )
}

/**
 * Complaints, drawn rather than thrown.
 *
 * A document is data; a typo in one has no business blanking the overlay it is in. Every
 * document in the repository is asserted to produce none of these (`help.test.ts`), so what this
 * actually serves is the person editing one with the app open beside them.
 */
function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null
  return (
    <div className="cfig__problems" role="alert">
      This figure did not build:
      <ul>
        {problems.map((problem, i) => (
          <li key={i}>{problem}</li>
        ))}
      </ul>
    </div>
  )
}
