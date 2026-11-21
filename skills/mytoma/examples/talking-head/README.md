# Worked example: a 20-second talking-head take

The edit of a phone take (vertical, 1080x1920 as played, ~29.97 fps variable, SDR), made with the step 3
workflow. Only the composition and transcript are here: the recording, `voice.wav`, `face/` and
`words.js` are made from the take and never committed.

```bash
python3 ../../scripts/audio/transcribe.py take.mp4 --outdir <work> --vocab "iCon, Claude"
python3 ../../scripts/take.py trim take.mp4 <work>
python3 ../../scripts/captions.py <work>                 # with keywords.json from here
node ../../scripts/cli.js new <work> --duration 20.1     # then copy index.html from here over it
python3 ../../scripts/take.py face <work> 0-3.5,19.25-20.1
node ../../scripts/cli.js sound <work> --voice <work>/voice.wav
node ../../scripts/cli.js render <work>
```

## Shot list

```
#   in-out         line (spoken)                                   shot                                    sound
01  0.00-3.50      Hey, my name is iCon, and I'm sitting on the…   face + slow push-in, name tag on "iCon"   pop@1.78
02  3.50-6.05      …trying to get some work done                   terminal types, WORK slam, DONE stamp     whoosh, type, hit@4.74, stamp@4.88
03  6.05-8.50      and chilling with the AI agent                  CHILL slam, "AI agent" pill               whoosh, hit@6.10, pop@7.04
04  8.50-10.65     named Claude.                                   CLAUDE slam                               whoosh, hit@8.58
05  10.65-12.90    And right now, there are 345 people             counter 0 → 345 lands with the word       whoosh, tick
06  12.90-19.25    eating spaghetti and 321 people eating ice…     bar chart: each bar grows as its food     whoosh, pop@14.25, pop@18.71
                                                                   is said (gap = 18.71 - 14.25)
07  19.25-20.10    (sign-off)                                      face, name tag                            pop@19.4
```

Captions are hidden (`nocap`) where the words on screen already say the line: 4.7-6.05, 6.05-8.5,
8.5-10.65, 11.6-12.9. The numbers on screen are the ones spoken, nothing else.
