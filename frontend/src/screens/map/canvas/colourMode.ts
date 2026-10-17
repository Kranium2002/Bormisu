/**
 * "Colour by: status | depth" of the borehole map, shared by the map (pins, cluster rings) and its
 * legend. Kept for the session in memory (a small store of its own: the app store and the URL do not
 * hold it); the default is the review status (FRONTEND.md F9).
 */
import { create } from 'zustand';
import type { ColourBy } from '../mapModel';

interface ColourModeState {
  colourBy: ColourBy;
  setColourBy(colourBy: ColourBy): void;
}

export const useColourMode = create<ColourModeState>()((set) => ({
  colourBy: 'status',
  setColourBy(colourBy) {
    set({ colourBy });
  },
}));
