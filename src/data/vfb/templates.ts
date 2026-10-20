/**
 * The VFB templates an image can be registered to, and which of them Coda has a space for.
 *
 * A VFB image is registered to one or more templates, and each registration is a separate set of
 * files. Only a template Coda can place EM geometry in gets a `TemplateSpaceId`: JRC2018U brain is
 * Coda's common space, so an expression pattern there draws beside any neuron transformed to it.
 * The others are offered so their images can be listed and drawn, but carry no space — never a
 * relabelling, since a JFRC2 image is not in JRC2018U whatever its numbers say.
 */

import type { TemplateSpaceId } from '../../core/values'
import { COMMON_SPACE } from '../transforms/spaces'

export interface VfbTemplate {
  readonly id: string
  readonly label: string
  readonly space?: TemplateSpaceId
  /**
   * VFB draws this template's images a quarter turn clockwise from how its stacks are stored, so a
   * view built from the stack turns it to match VFB's own picture. The VNC's stacks are 660×1290,
   * standing, and its thumbnails 1292×660, lying with the neck to the right; turning the stack's
   * projection clockwise lines its features up with the thumbnail's, and the mirrored turn does not
   * (`VFB/i/0010/2mv4`, 2026-10-14). Brain stacks match their thumbnails as stored.
   */
  readonly turnedClockwise?: boolean
}

/** JRC2018U brain: Coda's common space, and the template a connectome user's neurons are in. */
export const JRC2018U_BRAIN = 'VFB_00101567'
export const JRC2018U_VNC = 'VFB_00200000'

export const VFB_TEMPLATES: readonly VfbTemplate[] = [
  { id: JRC2018U_BRAIN, label: 'JRC2018U brain', space: COMMON_SPACE.id },
  { id: JRC2018U_VNC, label: 'JRC2018U VNC', turnedClockwise: true },
  { id: 'VFB_00017894', label: 'JFRC2 brain' },
]

/** A template's place in `VFB_TEMPLATES`, for listing images in that order; an unlisted one last. */
export function templateRank(id: string): number {
  const at = VFB_TEMPLATES.findIndex((t) => t.id === id)
  return at === -1 ? VFB_TEMPLATES.length : at
}

/** The template with this id; undefined for an id not listed, or none at all. */
export function vfbTemplate(id: string | undefined): VfbTemplate | undefined {
  return id === undefined ? undefined : VFB_TEMPLATES.find((t) => t.id === id)
}
