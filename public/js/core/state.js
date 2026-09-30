// The one shared state: the loaded library (store) and what the UI is showing (ui).
import { $ } from './dom.js';

export const PAGE = 60;
export const store = {
  records: [], byId: new Map(), concepts: [], conceptById: new Map(), children: new Map(), facets: [],
  overrides: {}, settings: {}, status: null, generatedAt: null, tagCache: new Map(), hay: new Map()
};
export const ui = { inboxPad: false, view: 'library', query: '', filters: new Set(), status: 'active', visible: PAGE, readerList: [], readerId: null, inboxId: null, readList: [], readFrom: null, taxFacet: 'topic', taxSelected: null, taxQuery: '', railOpen: new Set(), mobileRail: false, skillSel: null, keyEdit: null, askArchived: false };
export const view = () => $('#view');
