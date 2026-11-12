# PA impulse response

`pa-ir.wav` is "PA horn in hall" from Fokke van Saane's free impulse-response
collection (Factory Hall set, 2003): a real small PA horn recorded in a factory
hall by playing a sweep through it. Retrieved on 2026-11-12 from the Internet
Archive copy of fokkie.home.xs4all.nl (the original site is offline).

The author published these IRs as freeware and asked users to let him know
they use them. `src/pa-audio.ts` convolves PA announcements with it; without
this file the game falls back to a synthesised loudspeaker response.
