import {initialState as createState,command,actorFor} from '../domain.mjs';
// Existing AC fixtures explicitly preserve the old attachment workflow and dates.
// New source-only behavior is verified independently in source-data.test.mjs.
export function prepareLegacy(s){
 if(s.fixture==='demo'){
  command(s,actorFor('intake'),'schedule',{items:['RB-00054','RB-00120','RB-00180'].map(id=>({id,date:'2026-07-10'}))});
  s.fixture='legacy-test';
 }
 return s;
}
export function initialState(source,fixture){return prepareLegacy(createState(source,fixture));}
