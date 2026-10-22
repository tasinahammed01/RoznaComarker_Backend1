'use strict';
// Sanitized historical private-state fixture, test only.
module.exports={
  "submissionId": "6ad7d51f98657feb4a108063",
  "ocrJobId": "6ad7d51f98657feb4a108062",
  "pages": [
    {
      "fileId": "6ad7d51f98657feb4a108061",
      "fileOrder": 0,
      "pageNumber": 1,
      "pageIndex": 0,
      "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
      "sourceSha256": "7fa02b06f7a292e3a89822602ba921515e026fdbba716bfdef12886b643e4750",
      "mode": "astra_verified",
      "status": "OCR_UNCERTAIN",
      "version": "targeted-source-v2",
      "exactText": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of Self?\nSocial and cultural expectations shape\nLouise Mallard because in her social and cultural\ncontext,  women, such as her self, are expected\nto  divote their lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis Self-nigleacting way of living will eventually\nshift the  of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived  news of her husbends alliged\ndeath. She greever, yes, but after a while she",
      "exactTextSha256": "1f95992021575e9943279983a83ea306247a8dadf7cb39be02004ac08902cd99",
      "storedDisagreementCount": 3,
      "evidenceAvailable": true,
      "astra": {
        "requestedModel": "openai/gpt-6-astra",
        "returnedModel": "openai/gpt-6-astra",
        "activeTranscript": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of Self?\nSocial and cultural expectations shape\nLouise Mallard because in her social and cultural\ncontext,  women, such as her self, are expected\nto  divote their lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis Self-nigleacting way of living will eventually\nshift the  of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived  news of her husbends alliged\ndeath. She greever, yes, but after a while she",
        "segments": [
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "How do social and cultural expectations",
            "confidence": 0.94,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "shape Louise Marllard's choices, feelings and",
            "confidence": 0.86,
            "notes": "The additional strokes in the surname are retained."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "sence of Self?",
            "confidence": 0.87,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "Social and cultural expectations shape",
            "confidence": 0.93,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "Louise Mallard because in her social and cultural",
            "confidence": 0.9,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "context,  women, such as her self, are expected",
            "confidence": 0.89,
            "notes": "The uncertain word between 'context,' and 'women' is excluded."
          },
          {
            "type": "UNCERTAIN",
            "text": null,
            "confidence": 0.43,
            "notes": "The word before 'women' contains crowded, indistinct letter strokes."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "to  divote their lifes to there houses, husbends,",
            "confidence": 0.83,
            "notes": "The uncertain span after the initial 'to' is excluded. The inserted 'to' above the crossed-out word is included in reading order."
          },
          {
            "type": "UNCERTAIN",
            "text": "be",
            "confidence": 0.58,
            "notes": "The short span after the initial 'to' resembles 'be', but heavy strokes make its deletion status unclear."
          },
          {
            "type": "CROSSED_OUT_OR_DELETED",
            "text": "for",
            "confidence": 0.84,
            "notes": "Crossed out after 'lifes', with 'to' written above."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "and family in a way that make Them forget how",
            "confidence": 0.9,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "to live a little, and to take care of them selfes",
            "confidence": 0.89,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "insted of others, wich is a neccity for humens.",
            "confidence": 0.85,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "This Self-nigleacting way of living will eventually",
            "confidence": 0.85,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "shift the  of any human begin, as",
            "confidence": 0.88,
            "notes": "The uncertain word between 'the' and 'of' is excluded."
          },
          {
            "type": "UNCERTAIN",
            "text": null,
            "confidence": 0.55,
            "notes": "The word after 'the' has an indistinct sequence of medial and final strokes."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "what happen to Mrs. Mallard in the story, when",
            "confidence": 0.9,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "she recived  news of her husbends alliged",
            "confidence": 0.86,
            "notes": "The uncertain word before 'news' is excluded."
          },
          {
            "type": "UNCERTAIN",
            "text": null,
            "confidence": 0.5,
            "notes": "The word before 'news' resembles 'me'; the initial strokes could also be joined 'th'."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "death. She greever, yes, but after a while she",
            "confidence": 0.83,
            "notes": "The visible wording ends at 'she'."
          }
        ],
        "uncertainSpans": [
          {
            "visibleContext": "context, … women",
            "candidateReading": "marid",
            "reason": "The crowded humps and short strokes do not establish the exact letter sequence."
          },
          {
            "visibleContext": "to … divote",
            "candidateReading": "be",
            "reason": "The lettering resembles 'be', but it is unclear whether the heavy strokes delete it."
          },
          {
            "visibleContext": "shift the … of any human begin",
            "candidateReading": "judimeyt",
            "reason": "Several medial strokes and the character before the final tall stroke cannot be resolved confidently."
          },
          {
            "visibleContext": "she recived … news",
            "candidateReading": "me",
            "reason": "The first strokes resemble 'm' but may be joined 'th'; an exact reading is not established."
          }
        ],
        "usage": {
          "prompt_tokens": 3638,
          "completion_tokens": 4521,
          "total_tokens": 8159,
          "cost": 0.2715175,
          "thoughts_tokens": 3106
        },
        "latencyMs": 109180
      },
      "fable": {
        "requestedModel": "anthropic/claude-fable-5.1",
        "returnedModel": "anthropic/claude-fable-5.1",
        "activeTranscript": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of self ?\nSocial and cultural expectations shape\nLouise Mallard because In her social and cultural\ncontext, marrid wemen, such as her self, are expected\nto divote there lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis self-nigleacting way of living will eventually\nshift The judjment of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived the news of her husbend's alliged\ndeath. She greeved, yes, but after a while she",
        "segments": [
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "How do social and cultural expectations",
            "confidence": 0.95,
            "notes": "Handwritten prompt/question line copied by the student at top of page."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "shape Louise Marllard's choices, feelings and",
            "confidence": 0.92,
            "notes": "Surname visibly written with 'r' before 'll' (Marllard's)."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "sence of self ?",
            "confidence": 0.93,
            "notes": "Space before question mark as visible."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "Social and cultural expectations shape",
            "confidence": 0.95,
            "notes": "Indented first line of response."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "Louise Mallard because In her social and cultural",
            "confidence": 0.93,
            "notes": "'In' appears with a capital-looking I."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "context, marrid wemen, such as her self, are expected",
            "confidence": 0.75,
            "notes": "'context' and 'marrid' glyphs partly ambiguous; see uncertainSpans. 'expected' runs to the page edge."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "to divote there lifes to there houses, husbends,",
            "confidence": 0.85,
            "notes": "Word after 'to' is struck through (see deleted segment). 'for' struck through with 'to' written above it; active reading uses 'to'."
          },
          {
            "type": "CROSSED_OUT_OR_DELETED",
            "text": "be",
            "confidence": 0.8,
            "notes": "Struck-through word between 'to' and 'divote'."
          },
          {
            "type": "CROSSED_OUT_OR_DELETED",
            "text": "for",
            "confidence": 0.85,
            "notes": "Struck-through word replaced by superscript 'to'."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "and family in a way that make Them forget how",
            "confidence": 0.92,
            "notes": "'Them' appears with capital T."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "to live a little, and to take care of them selfes",
            "confidence": 0.9,
            "notes": "'them selfes' written as two words."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "insted of others, wich is a neccity for humens.",
            "confidence": 0.88,
            "notes": "'neccity' read from glyphs; possible 'necciity' but double c clear."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "This self-nigleacting way of living will eventually",
            "confidence": 0.85,
            "notes": "'nigleacting' read as written; 'eventually' has slight gap mid-word."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "shift The judjment of any human begin, as",
            "confidence": 0.75,
            "notes": "'judjment' glyphs ambiguous; 'The' capitalized; 'begin' as written."
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "what happen to Mrs. Mallard in the story, when",
            "confidence": 0.93,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "she recived the news of her husbend's alliged",
            "confidence": 0.9,
            "notes": ""
          },
          {
            "type": "ACTIVE_STUDENT_TEXT",
            "text": "death. She greeved, yes, but after a while she",
            "confidence": 0.85,
            "notes": "'greeved' final letters slightly looped; could read 'greevel'."
          }
        ],
        "uncertainSpans": [
          {
            "visibleContext": "in her social and cultural context, marrid wemen",
            "candidateReading": "context",
            "reason": "The letters after 'conte' are irregular; could be 'conteat' or 'context'."
          },
          {
            "visibleContext": "context, marrid wemen, such as her self",
            "candidateReading": "marrid",
            "reason": "Word begins with overwritten/scribbled strokes resembling 'mma'; exact letters cannot be confirmed."
          },
          {
            "visibleContext": "to divote there lifes to there houses",
            "candidateReading": "divote",
            "reason": "Final letter could be 'e' or 'r'."
          },
          {
            "visibleContext": "shift The judjment of any human begin",
            "candidateReading": "judjment",
            "reason": "Middle letters between 'jud' and 'ment' ambiguous (j/i/g)."
          },
          {
            "visibleContext": "death. She greeved, yes",
            "candidateReading": "greeved",
            "reason": "Final letters looped; could be 'greeved' or 'greevel'."
          }
        ],
        "usage": {
          "prompt_tokens": 5546,
          "completion_tokens": 2617,
          "total_tokens": 8163,
          "cost": 0.18631,
          "thoughts_tokens": 777
        },
        "latencyMs": 34370
      },
      "google": {
        "nativePages": [
          {
            "pageNumber": 1,
            "width": 1600,
            "height": 1200,
            "dimensionsMatch": true,
            "words": [
              {
                "id": "word_1_1",
                "text": "How",
                "paragraphIndex": 1,
                "confidence": 0.9756816029548645,
                "polygon": [
                  {
                    "x": 127,
                    "y": 70
                  },
                  {
                    "x": 241,
                    "y": 67
                  },
                  {
                    "x": 242,
                    "y": 113
                  },
                  {
                    "x": 128,
                    "y": 116
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_2",
                "text": "do",
                "paragraphIndex": 1,
                "confidence": 0.9890936613082886,
                "polygon": [
                  {
                    "x": 286,
                    "y": 67
                  },
                  {
                    "x": 345,
                    "y": 66
                  },
                  {
                    "x": 346,
                    "y": 111
                  },
                  {
                    "x": 287,
                    "y": 112
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_3",
                "text": "social",
                "paragraphIndex": 1,
                "confidence": 0.49750447273254395,
                "polygon": [
                  {
                    "x": 404,
                    "y": 64
                  },
                  {
                    "x": 558,
                    "y": 60
                  },
                  {
                    "x": 559,
                    "y": 105
                  },
                  {
                    "x": 405,
                    "y": 109
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_4",
                "text": "and",
                "paragraphIndex": 1,
                "confidence": 0.9553419351577759,
                "polygon": [
                  {
                    "x": 599,
                    "y": 60
                  },
                  {
                    "x": 712,
                    "y": 57
                  },
                  {
                    "x": 713,
                    "y": 102
                  },
                  {
                    "x": 600,
                    "y": 105
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_5",
                "text": "cultural",
                "paragraphIndex": 1,
                "confidence": 0.7542790770530701,
                "polygon": [
                  {
                    "x": 756,
                    "y": 56
                  },
                  {
                    "x": 996,
                    "y": 50
                  },
                  {
                    "x": 997,
                    "y": 95
                  },
                  {
                    "x": 757,
                    "y": 101
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_6",
                "text": "expectations",
                "paragraphIndex": 2,
                "confidence": 0.3562328815460205,
                "polygon": [
                  {
                    "x": 1057,
                    "y": 68
                  },
                  {
                    "x": 1382,
                    "y": 66
                  },
                  {
                    "x": 1382,
                    "y": 96
                  },
                  {
                    "x": 1057,
                    "y": 98
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_7",
                "text": "shape",
                "paragraphIndex": 3,
                "confidence": 0.7012973427772522,
                "polygon": [
                  {
                    "x": 51,
                    "y": 125
                  },
                  {
                    "x": 247,
                    "y": 122
                  },
                  {
                    "x": 248,
                    "y": 181
                  },
                  {
                    "x": 52,
                    "y": 184
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_8",
                "text": "Louise",
                "paragraphIndex": 3,
                "confidence": 0.5381941795349121,
                "polygon": [
                  {
                    "x": 269,
                    "y": 122
                  },
                  {
                    "x": 459,
                    "y": 119
                  },
                  {
                    "x": 460,
                    "y": 178
                  },
                  {
                    "x": 270,
                    "y": 181
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_9",
                "text": "Marllard's",
                "paragraphIndex": 3,
                "confidence": 0.5508801341056824,
                "polygon": [
                  {
                    "x": 495,
                    "y": 119
                  },
                  {
                    "x": 795,
                    "y": 114
                  },
                  {
                    "x": 796,
                    "y": 172
                  },
                  {
                    "x": 496,
                    "y": 177
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_10",
                "text": "choices",
                "paragraphIndex": 3,
                "confidence": 0.6747648119926453,
                "polygon": [
                  {
                    "x": 829,
                    "y": 113
                  },
                  {
                    "x": 1073,
                    "y": 109
                  },
                  {
                    "x": 1074,
                    "y": 168
                  },
                  {
                    "x": 830,
                    "y": 172
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_11",
                "text": ",",
                "paragraphIndex": 3,
                "confidence": 0.8385185599327087,
                "polygon": [
                  {
                    "x": 1070,
                    "y": 110
                  },
                  {
                    "x": 1102,
                    "y": 110
                  },
                  {
                    "x": 1103,
                    "y": 168
                  },
                  {
                    "x": 1071,
                    "y": 168
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_12",
                "text": "feelings",
                "paragraphIndex": 3,
                "confidence": 0.8960950970649719,
                "polygon": [
                  {
                    "x": 1125,
                    "y": 109
                  },
                  {
                    "x": 1370,
                    "y": 105
                  },
                  {
                    "x": 1371,
                    "y": 164
                  },
                  {
                    "x": 1126,
                    "y": 168
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_13",
                "text": "and",
                "paragraphIndex": 3,
                "confidence": 0.8987798690795898,
                "polygon": [
                  {
                    "x": 1398,
                    "y": 105
                  },
                  {
                    "x": 1510,
                    "y": 103
                  },
                  {
                    "x": 1511,
                    "y": 161
                  },
                  {
                    "x": 1399,
                    "y": 163
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_14",
                "text": "Sence",
                "paragraphIndex": 4,
                "confidence": 0.6076946258544922,
                "polygon": [
                  {
                    "x": 63,
                    "y": 210
                  },
                  {
                    "x": 218,
                    "y": 209
                  },
                  {
                    "x": 218,
                    "y": 232
                  },
                  {
                    "x": 63,
                    "y": 233
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_15",
                "text": "of",
                "paragraphIndex": 5,
                "confidence": 0.7030397057533264,
                "polygon": [
                  {
                    "x": 278,
                    "y": 202
                  },
                  {
                    "x": 351,
                    "y": 198
                  },
                  {
                    "x": 353,
                    "y": 232
                  },
                  {
                    "x": 280,
                    "y": 236
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_16",
                "text": "Self",
                "paragraphIndex": 5,
                "confidence": 0.6498571038246155,
                "polygon": [
                  {
                    "x": 389,
                    "y": 195
                  },
                  {
                    "x": 516,
                    "y": 188
                  },
                  {
                    "x": 518,
                    "y": 223
                  },
                  {
                    "x": 391,
                    "y": 230
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_17",
                "text": "2",
                "paragraphIndex": 5,
                "confidence": 0.9002519249916077,
                "polygon": [
                  {
                    "x": 530,
                    "y": 187
                  },
                  {
                    "x": 562,
                    "y": 185
                  },
                  {
                    "x": 564,
                    "y": 219
                  },
                  {
                    "x": 532,
                    "y": 221
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_18",
                "text": "Social",
                "paragraphIndex": 6,
                "confidence": 0.6534449458122253,
                "polygon": [
                  {
                    "x": 207,
                    "y": 308
                  },
                  {
                    "x": 403,
                    "y": 306
                  },
                  {
                    "x": 404,
                    "y": 356
                  },
                  {
                    "x": 208,
                    "y": 358
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_19",
                "text": "and",
                "paragraphIndex": 6,
                "confidence": 0.967769205570221,
                "polygon": [
                  {
                    "x": 454,
                    "y": 306
                  },
                  {
                    "x": 572,
                    "y": 305
                  },
                  {
                    "x": 573,
                    "y": 354
                  },
                  {
                    "x": 455,
                    "y": 355
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_20",
                "text": "cultural",
                "paragraphIndex": 6,
                "confidence": 0.9497998952865601,
                "polygon": [
                  {
                    "x": 623,
                    "y": 304
                  },
                  {
                    "x": 892,
                    "y": 301
                  },
                  {
                    "x": 892,
                    "y": 350
                  },
                  {
                    "x": 624,
                    "y": 353
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_21",
                "text": "expectations",
                "paragraphIndex": 6,
                "confidence": 0.8182128071784973,
                "polygon": [
                  {
                    "x": 951,
                    "y": 300
                  },
                  {
                    "x": 1366,
                    "y": 296
                  },
                  {
                    "x": 1366,
                    "y": 346
                  },
                  {
                    "x": 952,
                    "y": 350
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_22",
                "text": "shape",
                "paragraphIndex": 6,
                "confidence": 0.8234612941741943,
                "polygon": [
                  {
                    "x": 1401,
                    "y": 296
                  },
                  {
                    "x": 1539,
                    "y": 295
                  },
                  {
                    "x": 1540,
                    "y": 344
                  },
                  {
                    "x": 1402,
                    "y": 345
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_23",
                "text": "Louise",
                "paragraphIndex": 6,
                "confidence": 0.33286648988723755,
                "polygon": [
                  {
                    "x": 61,
                    "y": 379
                  },
                  {
                    "x": 271,
                    "y": 377
                  },
                  {
                    "x": 271,
                    "y": 423
                  },
                  {
                    "x": 62,
                    "y": 425
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_24",
                "text": "Mallard",
                "paragraphIndex": 6,
                "confidence": 0.9328480958938599,
                "polygon": [
                  {
                    "x": 291,
                    "y": 377
                  },
                  {
                    "x": 485,
                    "y": 375
                  },
                  {
                    "x": 485,
                    "y": 420
                  },
                  {
                    "x": 291,
                    "y": 422
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_25",
                "text": "because",
                "paragraphIndex": 6,
                "confidence": 0.912490963935852,
                "polygon": [
                  {
                    "x": 510,
                    "y": 374
                  },
                  {
                    "x": 733,
                    "y": 372
                  },
                  {
                    "x": 733,
                    "y": 418
                  },
                  {
                    "x": 511,
                    "y": 420
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_26",
                "text": "in",
                "paragraphIndex": 6,
                "confidence": 0.6325222849845886,
                "polygon": [
                  {
                    "x": 754,
                    "y": 372
                  },
                  {
                    "x": 807,
                    "y": 371
                  },
                  {
                    "x": 807,
                    "y": 416
                  },
                  {
                    "x": 754,
                    "y": 417
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_27",
                "text": "her",
                "paragraphIndex": 6,
                "confidence": 0.689882218837738,
                "polygon": [
                  {
                    "x": 860,
                    "y": 374
                  },
                  {
                    "x": 963,
                    "y": 372
                  },
                  {
                    "x": 964,
                    "y": 415
                  },
                  {
                    "x": 861,
                    "y": 417
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_28",
                "text": "social",
                "paragraphIndex": 6,
                "confidence": 0.6628983020782471,
                "polygon": [
                  {
                    "x": 1002,
                    "y": 372
                  },
                  {
                    "x": 1202,
                    "y": 369
                  },
                  {
                    "x": 1203,
                    "y": 411
                  },
                  {
                    "x": 1003,
                    "y": 414
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_29",
                "text": "and",
                "paragraphIndex": 6,
                "confidence": 0.9641004204750061,
                "polygon": [
                  {
                    "x": 1227,
                    "y": 368
                  },
                  {
                    "x": 1336,
                    "y": 366
                  },
                  {
                    "x": 1337,
                    "y": 409
                  },
                  {
                    "x": 1228,
                    "y": 411
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_30",
                "text": "cultural",
                "paragraphIndex": 6,
                "confidence": 0.7863626480102539,
                "polygon": [
                  {
                    "x": 1350,
                    "y": 366
                  },
                  {
                    "x": 1544,
                    "y": 363
                  },
                  {
                    "x": 1545,
                    "y": 406
                  },
                  {
                    "x": 1351,
                    "y": 409
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_31",
                "text": "to",
                "paragraphIndex": 7,
                "confidence": 0.8892339468002319,
                "polygon": [
                  {
                    "x": 751,
                    "y": 484
                  },
                  {
                    "x": 800,
                    "y": 482
                  },
                  {
                    "x": 801,
                    "y": 502
                  },
                  {
                    "x": 752,
                    "y": 504
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_32",
                "text": "of",
                "paragraphIndex": 8,
                "confidence": 0.6490835547447205,
                "polygon": [
                  {
                    "x": 763,
                    "y": 492
                  },
                  {
                    "x": 827,
                    "y": 491
                  },
                  {
                    "x": 828,
                    "y": 530
                  },
                  {
                    "x": 764,
                    "y": 531
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_33",
                "text": "context",
                "paragraphIndex": 9,
                "confidence": 0.8212822675704956,
                "polygon": [
                  {
                    "x": 42,
                    "y": 445
                  },
                  {
                    "x": 326,
                    "y": 440
                  },
                  {
                    "x": 327,
                    "y": 486
                  },
                  {
                    "x": 43,
                    "y": 491
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_34",
                "text": ",",
                "paragraphIndex": 9,
                "confidence": 0.8137522339820862,
                "polygon": [
                  {
                    "x": 309,
                    "y": 441
                  },
                  {
                    "x": 355,
                    "y": 440
                  },
                  {
                    "x": 356,
                    "y": 485
                  },
                  {
                    "x": 310,
                    "y": 486
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_35",
                "text": "mmakrid",
                "paragraphIndex": 9,
                "confidence": 0.28914064168930054,
                "polygon": [
                  {
                    "x": 352,
                    "y": 440
                  },
                  {
                    "x": 529,
                    "y": 437
                  },
                  {
                    "x": 530,
                    "y": 483
                  },
                  {
                    "x": 353,
                    "y": 486
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_36",
                "text": "wemen",
                "paragraphIndex": 9,
                "confidence": 0.5907641053199768,
                "polygon": [
                  {
                    "x": 549,
                    "y": 437
                  },
                  {
                    "x": 714,
                    "y": 434
                  },
                  {
                    "x": 715,
                    "y": 480
                  },
                  {
                    "x": 550,
                    "y": 483
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_37",
                "text": ",",
                "paragraphIndex": 9,
                "confidence": 0.5605393648147583,
                "polygon": [
                  {
                    "x": 708,
                    "y": 435
                  },
                  {
                    "x": 740,
                    "y": 434
                  },
                  {
                    "x": 741,
                    "y": 479
                  },
                  {
                    "x": 709,
                    "y": 480
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_38",
                "text": "such",
                "paragraphIndex": 9,
                "confidence": 0.7308912873268127,
                "polygon": [
                  {
                    "x": 750,
                    "y": 434
                  },
                  {
                    "x": 858,
                    "y": 432
                  },
                  {
                    "x": 859,
                    "y": 477
                  },
                  {
                    "x": 751,
                    "y": 479
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_39",
                "text": "as",
                "paragraphIndex": 9,
                "confidence": 0.9894814491271973,
                "polygon": [
                  {
                    "x": 881,
                    "y": 432
                  },
                  {
                    "x": 960,
                    "y": 431
                  },
                  {
                    "x": 961,
                    "y": 476
                  },
                  {
                    "x": 882,
                    "y": 477
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_40",
                "text": "her",
                "paragraphIndex": 9,
                "confidence": 0.9654644727706909,
                "polygon": [
                  {
                    "x": 980,
                    "y": 430
                  },
                  {
                    "x": 1079,
                    "y": 428
                  },
                  {
                    "x": 1080,
                    "y": 474
                  },
                  {
                    "x": 981,
                    "y": 476
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_41",
                "text": "self",
                "paragraphIndex": 9,
                "confidence": 0.9605658650398254,
                "polygon": [
                  {
                    "x": 1101,
                    "y": 428
                  },
                  {
                    "x": 1219,
                    "y": 426
                  },
                  {
                    "x": 1220,
                    "y": 472
                  },
                  {
                    "x": 1102,
                    "y": 474
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_42",
                "text": ",",
                "paragraphIndex": 9,
                "confidence": 0.6398108005523682,
                "polygon": [
                  {
                    "x": 1223,
                    "y": 426
                  },
                  {
                    "x": 1253,
                    "y": 426
                  },
                  {
                    "x": 1254,
                    "y": 471
                  },
                  {
                    "x": 1224,
                    "y": 471
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_43",
                "text": "are",
                "paragraphIndex": 9,
                "confidence": 0.8285880088806152,
                "polygon": [
                  {
                    "x": 1281,
                    "y": 425
                  },
                  {
                    "x": 1361,
                    "y": 424
                  },
                  {
                    "x": 1362,
                    "y": 469
                  },
                  {
                    "x": 1282,
                    "y": 470
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_44",
                "text": "expected",
                "paragraphIndex": 9,
                "confidence": 0.6633040904998779,
                "polygon": [
                  {
                    "x": 1383,
                    "y": 423
                  },
                  {
                    "x": 1573,
                    "y": 420
                  },
                  {
                    "x": 1574,
                    "y": 466
                  },
                  {
                    "x": 1384,
                    "y": 469
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_45",
                "text": "to",
                "paragraphIndex": 9,
                "confidence": 0.9745866656303406,
                "polygon": [
                  {
                    "x": 60,
                    "y": 507
                  },
                  {
                    "x": 120,
                    "y": 506
                  },
                  {
                    "x": 121,
                    "y": 551
                  },
                  {
                    "x": 61,
                    "y": 552
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_46",
                "text": "be",
                "paragraphIndex": 9,
                "confidence": 0.90733802318573,
                "polygon": [
                  {
                    "x": 151,
                    "y": 506
                  },
                  {
                    "x": 214,
                    "y": 505
                  },
                  {
                    "x": 215,
                    "y": 549
                  },
                  {
                    "x": 152,
                    "y": 550
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_47",
                "text": "divote",
                "paragraphIndex": 9,
                "confidence": 0.4468921720981598,
                "polygon": [
                  {
                    "x": 247,
                    "y": 505
                  },
                  {
                    "x": 400,
                    "y": 503
                  },
                  {
                    "x": 401,
                    "y": 547
                  },
                  {
                    "x": 248,
                    "y": 549
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_48",
                "text": "there",
                "paragraphIndex": 9,
                "confidence": 0.7296448349952698,
                "polygon": [
                  {
                    "x": 424,
                    "y": 502
                  },
                  {
                    "x": 538,
                    "y": 500
                  },
                  {
                    "x": 539,
                    "y": 545
                  },
                  {
                    "x": 425,
                    "y": 547
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_49",
                "text": "lifes",
                "paragraphIndex": 9,
                "confidence": 0.7204270362854004,
                "polygon": [
                  {
                    "x": 572,
                    "y": 500
                  },
                  {
                    "x": 694,
                    "y": 498
                  },
                  {
                    "x": 695,
                    "y": 543
                  },
                  {
                    "x": 573,
                    "y": 545
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_50",
                "text": "fet",
                "paragraphIndex": 9,
                "confidence": 0.4644356667995453,
                "polygon": [
                  {
                    "x": 736,
                    "y": 498
                  },
                  {
                    "x": 826,
                    "y": 497
                  },
                  {
                    "x": 827,
                    "y": 542
                  },
                  {
                    "x": 737,
                    "y": 543
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_51",
                "text": "there",
                "paragraphIndex": 9,
                "confidence": 0.8872582912445068,
                "polygon": [
                  {
                    "x": 867,
                    "y": 497
                  },
                  {
                    "x": 981,
                    "y": 495
                  },
                  {
                    "x": 982,
                    "y": 539
                  },
                  {
                    "x": 868,
                    "y": 541
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_52",
                "text": "houses",
                "paragraphIndex": 9,
                "confidence": 0.7325900197029114,
                "polygon": [
                  {
                    "x": 1017,
                    "y": 494
                  },
                  {
                    "x": 1195,
                    "y": 492
                  },
                  {
                    "x": 1196,
                    "y": 537
                  },
                  {
                    "x": 1018,
                    "y": 539
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_53",
                "text": ",",
                "paragraphIndex": 9,
                "confidence": 0.770031750202179,
                "polygon": [
                  {
                    "x": 1202,
                    "y": 492
                  },
                  {
                    "x": 1226,
                    "y": 492
                  },
                  {
                    "x": 1227,
                    "y": 536
                  },
                  {
                    "x": 1203,
                    "y": 536
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_54",
                "text": "has",
                "paragraphIndex": 9,
                "confidence": 0.6385577917098999,
                "polygon": [
                  {
                    "x": 1254,
                    "y": 491
                  },
                  {
                    "x": 1352,
                    "y": 490
                  },
                  {
                    "x": 1353,
                    "y": 535
                  },
                  {
                    "x": 1255,
                    "y": 536
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_55",
                "text": "bends",
                "paragraphIndex": 9,
                "confidence": 0.880062460899353,
                "polygon": [
                  {
                    "x": 1351,
                    "y": 490
                  },
                  {
                    "x": 1505,
                    "y": 488
                  },
                  {
                    "x": 1506,
                    "y": 533
                  },
                  {
                    "x": 1352,
                    "y": 535
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_56",
                "text": ",",
                "paragraphIndex": 9,
                "confidence": 0.8129140138626099,
                "polygon": [
                  {
                    "x": 1493,
                    "y": 488
                  },
                  {
                    "x": 1526,
                    "y": 488
                  },
                  {
                    "x": 1527,
                    "y": 532
                  },
                  {
                    "x": 1494,
                    "y": 532
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_57",
                "text": "and",
                "paragraphIndex": 9,
                "confidence": 0.9447349309921265,
                "polygon": [
                  {
                    "x": 47,
                    "y": 568
                  },
                  {
                    "x": 166,
                    "y": 568
                  },
                  {
                    "x": 166,
                    "y": 613
                  },
                  {
                    "x": 47,
                    "y": 613
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_58",
                "text": "family",
                "paragraphIndex": 9,
                "confidence": 0.7335167527198792,
                "polygon": [
                  {
                    "x": 185,
                    "y": 568
                  },
                  {
                    "x": 382,
                    "y": 569
                  },
                  {
                    "x": 382,
                    "y": 615
                  },
                  {
                    "x": 185,
                    "y": 614
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_59",
                "text": "in",
                "paragraphIndex": 9,
                "confidence": 0.9738422632217407,
                "polygon": [
                  {
                    "x": 394,
                    "y": 569
                  },
                  {
                    "x": 453,
                    "y": 569
                  },
                  {
                    "x": 453,
                    "y": 614
                  },
                  {
                    "x": 394,
                    "y": 614
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_60",
                "text": "way",
                "paragraphIndex": 9,
                "confidence": 0.6061387658119202,
                "polygon": [
                  {
                    "x": 560,
                    "y": 562
                  },
                  {
                    "x": 672,
                    "y": 560
                  },
                  {
                    "x": 673,
                    "y": 604
                  },
                  {
                    "x": 561,
                    "y": 606
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_61",
                "text": "that",
                "paragraphIndex": 9,
                "confidence": 0.9811248183250427,
                "polygon": [
                  {
                    "x": 708,
                    "y": 559
                  },
                  {
                    "x": 824,
                    "y": 557
                  },
                  {
                    "x": 825,
                    "y": 601
                  },
                  {
                    "x": 709,
                    "y": 603
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_62",
                "text": "make",
                "paragraphIndex": 9,
                "confidence": 0.9756873250007629,
                "polygon": [
                  {
                    "x": 866,
                    "y": 556
                  },
                  {
                    "x": 996,
                    "y": 554
                  },
                  {
                    "x": 997,
                    "y": 598
                  },
                  {
                    "x": 867,
                    "y": 600
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_63",
                "text": "them",
                "paragraphIndex": 9,
                "confidence": 0.700400173664093,
                "polygon": [
                  {
                    "x": 1023,
                    "y": 554
                  },
                  {
                    "x": 1128,
                    "y": 552
                  },
                  {
                    "x": 1129,
                    "y": 595
                  },
                  {
                    "x": 1024,
                    "y": 597
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_64",
                "text": "forget",
                "paragraphIndex": 9,
                "confidence": 0.8778775334358215,
                "polygon": [
                  {
                    "x": 1171,
                    "y": 551
                  },
                  {
                    "x": 1316,
                    "y": 548
                  },
                  {
                    "x": 1317,
                    "y": 592
                  },
                  {
                    "x": 1172,
                    "y": 595
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_65",
                "text": "how",
                "paragraphIndex": 9,
                "confidence": 0.8999117612838745,
                "polygon": [
                  {
                    "x": 1353,
                    "y": 547
                  },
                  {
                    "x": 1441,
                    "y": 545
                  },
                  {
                    "x": 1442,
                    "y": 589
                  },
                  {
                    "x": 1354,
                    "y": 591
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_66",
                "text": "to",
                "paragraphIndex": 9,
                "confidence": 0.9469314813613892,
                "polygon": [
                  {
                    "x": 48,
                    "y": 627
                  },
                  {
                    "x": 112,
                    "y": 626
                  },
                  {
                    "x": 113,
                    "y": 666
                  },
                  {
                    "x": 49,
                    "y": 667
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_67",
                "text": "live",
                "paragraphIndex": 9,
                "confidence": 0.9469649195671082,
                "polygon": [
                  {
                    "x": 140,
                    "y": 626
                  },
                  {
                    "x": 222,
                    "y": 625
                  },
                  {
                    "x": 223,
                    "y": 664
                  },
                  {
                    "x": 141,
                    "y": 665
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_68",
                "text": "a",
                "paragraphIndex": 9,
                "confidence": 0.7601314187049866,
                "polygon": [
                  {
                    "x": 242,
                    "y": 624
                  },
                  {
                    "x": 281,
                    "y": 623
                  },
                  {
                    "x": 282,
                    "y": 662
                  },
                  {
                    "x": 243,
                    "y": 663
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_69",
                "text": "little",
                "paragraphIndex": 9,
                "confidence": 0.8363741040229797,
                "polygon": [
                  {
                    "x": 304,
                    "y": 623
                  },
                  {
                    "x": 434,
                    "y": 621
                  },
                  {
                    "x": 435,
                    "y": 661
                  },
                  {
                    "x": 305,
                    "y": 663
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_70",
                "text": ",",
                "paragraphIndex": 9,
                "confidence": 0.8395615816116333,
                "polygon": [
                  {
                    "x": 439,
                    "y": 621
                  },
                  {
                    "x": 468,
                    "y": 621
                  },
                  {
                    "x": 469,
                    "y": 660
                  },
                  {
                    "x": 440,
                    "y": 660
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_71",
                "text": "and",
                "paragraphIndex": 9,
                "confidence": 0.9520708322525024,
                "polygon": [
                  {
                    "x": 486,
                    "y": 620
                  },
                  {
                    "x": 590,
                    "y": 618
                  },
                  {
                    "x": 591,
                    "y": 657
                  },
                  {
                    "x": 487,
                    "y": 659
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_72",
                "text": "to",
                "paragraphIndex": 9,
                "confidence": 0.9910405874252319,
                "polygon": [
                  {
                    "x": 624,
                    "y": 618
                  },
                  {
                    "x": 684,
                    "y": 617
                  },
                  {
                    "x": 685,
                    "y": 656
                  },
                  {
                    "x": 625,
                    "y": 657
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_73",
                "text": "take",
                "paragraphIndex": 9,
                "confidence": 0.9877400398254395,
                "polygon": [
                  {
                    "x": 708,
                    "y": 616
                  },
                  {
                    "x": 827,
                    "y": 614
                  },
                  {
                    "x": 828,
                    "y": 654
                  },
                  {
                    "x": 709,
                    "y": 656
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_74",
                "text": "care",
                "paragraphIndex": 9,
                "confidence": 0.8778627514839172,
                "polygon": [
                  {
                    "x": 865,
                    "y": 614
                  },
                  {
                    "x": 985,
                    "y": 612
                  },
                  {
                    "x": 986,
                    "y": 651
                  },
                  {
                    "x": 866,
                    "y": 653
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_75",
                "text": "of",
                "paragraphIndex": 9,
                "confidence": 0.9868495464324951,
                "polygon": [
                  {
                    "x": 1016,
                    "y": 612
                  },
                  {
                    "x": 1083,
                    "y": 611
                  },
                  {
                    "x": 1084,
                    "y": 650
                  },
                  {
                    "x": 1017,
                    "y": 651
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_76",
                "text": "them",
                "paragraphIndex": 9,
                "confidence": 0.9211373329162598,
                "polygon": [
                  {
                    "x": 1112,
                    "y": 610
                  },
                  {
                    "x": 1219,
                    "y": 608
                  },
                  {
                    "x": 1220,
                    "y": 648
                  },
                  {
                    "x": 1113,
                    "y": 650
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_77",
                "text": "selfes",
                "paragraphIndex": 9,
                "confidence": 0.6663447618484497,
                "polygon": [
                  {
                    "x": 1268,
                    "y": 607
                  },
                  {
                    "x": 1425,
                    "y": 604
                  },
                  {
                    "x": 1426,
                    "y": 644
                  },
                  {
                    "x": 1269,
                    "y": 647
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_78",
                "text": "a",
                "paragraphIndex": 10,
                "confidence": 0.9088459014892578,
                "polygon": [
                  {
                    "x": 490,
                    "y": 577
                  },
                  {
                    "x": 527,
                    "y": 576
                  },
                  {
                    "x": 528,
                    "y": 601
                  },
                  {
                    "x": 491,
                    "y": 602
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_79",
                "text": "a",
                "paragraphIndex": 11,
                "confidence": 0.9291658401489258,
                "polygon": [
                  {
                    "x": 852,
                    "y": 694
                  },
                  {
                    "x": 884,
                    "y": 694
                  },
                  {
                    "x": 884,
                    "y": 710
                  },
                  {
                    "x": 852,
                    "y": 710
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_80",
                "text": "insted",
                "paragraphIndex": 12,
                "confidence": 0.7028382420539856,
                "polygon": [
                  {
                    "x": 54,
                    "y": 689
                  },
                  {
                    "x": 237,
                    "y": 685
                  },
                  {
                    "x": 238,
                    "y": 731
                  },
                  {
                    "x": 55,
                    "y": 735
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_81",
                "text": "of",
                "paragraphIndex": 12,
                "confidence": 0.7799253463745117,
                "polygon": [
                  {
                    "x": 267,
                    "y": 685
                  },
                  {
                    "x": 335,
                    "y": 683
                  },
                  {
                    "x": 336,
                    "y": 728
                  },
                  {
                    "x": 268,
                    "y": 730
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_82",
                "text": "others",
                "paragraphIndex": 12,
                "confidence": 0.5418005585670471,
                "polygon": [
                  {
                    "x": 362,
                    "y": 682
                  },
                  {
                    "x": 540,
                    "y": 678
                  },
                  {
                    "x": 541,
                    "y": 724
                  },
                  {
                    "x": 363,
                    "y": 728
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_83",
                "text": ",",
                "paragraphIndex": 12,
                "confidence": 0.8459180593490601,
                "polygon": [
                  {
                    "x": 543,
                    "y": 678
                  },
                  {
                    "x": 573,
                    "y": 677
                  },
                  {
                    "x": 574,
                    "y": 722
                  },
                  {
                    "x": 544,
                    "y": 723
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_84",
                "text": "wich",
                "paragraphIndex": 12,
                "confidence": 0.8427891135215759,
                "polygon": [
                  {
                    "x": 595,
                    "y": 677
                  },
                  {
                    "x": 708,
                    "y": 674
                  },
                  {
                    "x": 709,
                    "y": 719
                  },
                  {
                    "x": 596,
                    "y": 722
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_85",
                "text": "is",
                "paragraphIndex": 12,
                "confidence": 0.9525731205940247,
                "polygon": [
                  {
                    "x": 754,
                    "y": 673
                  },
                  {
                    "x": 811,
                    "y": 672
                  },
                  {
                    "x": 812,
                    "y": 718
                  },
                  {
                    "x": 755,
                    "y": 719
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_86",
                "text": "neccity",
                "paragraphIndex": 12,
                "confidence": 0.7519907355308533,
                "polygon": [
                  {
                    "x": 910,
                    "y": 678
                  },
                  {
                    "x": 1121,
                    "y": 670
                  },
                  {
                    "x": 1123,
                    "y": 715
                  },
                  {
                    "x": 912,
                    "y": 723
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_87",
                "text": "for",
                "paragraphIndex": 12,
                "confidence": 0.9672333002090454,
                "polygon": [
                  {
                    "x": 1161,
                    "y": 669
                  },
                  {
                    "x": 1252,
                    "y": 666
                  },
                  {
                    "x": 1254,
                    "y": 710
                  },
                  {
                    "x": 1163,
                    "y": 713
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_88",
                "text": "humens",
                "paragraphIndex": 12,
                "confidence": 0.700973391532898,
                "polygon": [
                  {
                    "x": 1280,
                    "y": 664
                  },
                  {
                    "x": 1468,
                    "y": 657
                  },
                  {
                    "x": 1470,
                    "y": 702
                  },
                  {
                    "x": 1282,
                    "y": 709
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_89",
                "text": "This",
                "paragraphIndex": 12,
                "confidence": 0.910735011100769,
                "polygon": [
                  {
                    "x": 50,
                    "y": 748
                  },
                  {
                    "x": 149,
                    "y": 747
                  },
                  {
                    "x": 150,
                    "y": 797
                  },
                  {
                    "x": 51,
                    "y": 798
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_90",
                "text": "Self",
                "paragraphIndex": 12,
                "confidence": 0.7030642032623291,
                "polygon": [
                  {
                    "x": 171,
                    "y": 747
                  },
                  {
                    "x": 285,
                    "y": 746
                  },
                  {
                    "x": 286,
                    "y": 795
                  },
                  {
                    "x": 172,
                    "y": 796
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_91",
                "text": "-",
                "paragraphIndex": 12,
                "confidence": 0.8403964638710022,
                "polygon": [
                  {
                    "x": 290,
                    "y": 745
                  },
                  {
                    "x": 324,
                    "y": 745
                  },
                  {
                    "x": 325,
                    "y": 794
                  },
                  {
                    "x": 291,
                    "y": 794
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_92",
                "text": "niglearting",
                "paragraphIndex": 12,
                "confidence": 0.6553616523742676,
                "polygon": [
                  {
                    "x": 332,
                    "y": 744
                  },
                  {
                    "x": 650,
                    "y": 740
                  },
                  {
                    "x": 651,
                    "y": 790
                  },
                  {
                    "x": 333,
                    "y": 794
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_93",
                "text": "way",
                "paragraphIndex": 12,
                "confidence": 0.7704145908355713,
                "polygon": [
                  {
                    "x": 677,
                    "y": 741
                  },
                  {
                    "x": 804,
                    "y": 739
                  },
                  {
                    "x": 805,
                    "y": 788
                  },
                  {
                    "x": 678,
                    "y": 790
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_94",
                "text": "of",
                "paragraphIndex": 12,
                "confidence": 0.9775433540344238,
                "polygon": [
                  {
                    "x": 843,
                    "y": 738
                  },
                  {
                    "x": 918,
                    "y": 737
                  },
                  {
                    "x": 919,
                    "y": 786
                  },
                  {
                    "x": 844,
                    "y": 787
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_95",
                "text": "living",
                "paragraphIndex": 12,
                "confidence": 0.8540409803390503,
                "polygon": [
                  {
                    "x": 939,
                    "y": 737
                  },
                  {
                    "x": 1087,
                    "y": 735
                  },
                  {
                    "x": 1088,
                    "y": 785
                  },
                  {
                    "x": 940,
                    "y": 787
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_96",
                "text": "will",
                "paragraphIndex": 12,
                "confidence": 0.9802289009094238,
                "polygon": [
                  {
                    "x": 1122,
                    "y": 734
                  },
                  {
                    "x": 1222,
                    "y": 733
                  },
                  {
                    "x": 1223,
                    "y": 783
                  },
                  {
                    "x": 1123,
                    "y": 784
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_97",
                "text": "eventually",
                "paragraphIndex": 12,
                "confidence": 0.9288662075996399,
                "polygon": [
                  {
                    "x": 1241,
                    "y": 733
                  },
                  {
                    "x": 1518,
                    "y": 729
                  },
                  {
                    "x": 1519,
                    "y": 779
                  },
                  {
                    "x": 1242,
                    "y": 783
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_98",
                "text": ".",
                "paragraphIndex": 12,
                "confidence": 0.4823547303676605,
                "polygon": [
                  {
                    "x": 1502,
                    "y": 730
                  },
                  {
                    "x": 1528,
                    "y": 730
                  },
                  {
                    "x": 1529,
                    "y": 779
                  },
                  {
                    "x": 1503,
                    "y": 779
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_99",
                "text": "shift",
                "paragraphIndex": 12,
                "confidence": 0.6456966400146484,
                "polygon": [
                  {
                    "x": 55,
                    "y": 803
                  },
                  {
                    "x": 218,
                    "y": 801
                  },
                  {
                    "x": 218,
                    "y": 847
                  },
                  {
                    "x": 55,
                    "y": 849
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_100",
                "text": "The",
                "paragraphIndex": 12,
                "confidence": 0.758027970790863,
                "polygon": [
                  {
                    "x": 253,
                    "y": 801
                  },
                  {
                    "x": 335,
                    "y": 800
                  },
                  {
                    "x": 335,
                    "y": 846
                  },
                  {
                    "x": 253,
                    "y": 847
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_101",
                "text": "Judiment",
                "paragraphIndex": 12,
                "confidence": 0.5640933513641357,
                "polygon": [
                  {
                    "x": 374,
                    "y": 800
                  },
                  {
                    "x": 652,
                    "y": 797
                  },
                  {
                    "x": 652,
                    "y": 843
                  },
                  {
                    "x": 374,
                    "y": 846
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_102",
                "text": "of",
                "paragraphIndex": 12,
                "confidence": 0.9524272084236145,
                "polygon": [
                  {
                    "x": 683,
                    "y": 797
                  },
                  {
                    "x": 764,
                    "y": 796
                  },
                  {
                    "x": 764,
                    "y": 841
                  },
                  {
                    "x": 683,
                    "y": 842
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_103",
                "text": "any",
                "paragraphIndex": 12,
                "confidence": 0.7339332699775696,
                "polygon": [
                  {
                    "x": 802,
                    "y": 796
                  },
                  {
                    "x": 895,
                    "y": 795
                  },
                  {
                    "x": 895,
                    "y": 840
                  },
                  {
                    "x": 802,
                    "y": 841
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_104",
                "text": "human",
                "paragraphIndex": 12,
                "confidence": 0.7199358344078064,
                "polygon": [
                  {
                    "x": 933,
                    "y": 794
                  },
                  {
                    "x": 1121,
                    "y": 792
                  },
                  {
                    "x": 1121,
                    "y": 838
                  },
                  {
                    "x": 933,
                    "y": 840
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_105",
                "text": "begin",
                "paragraphIndex": 12,
                "confidence": 0.9883797764778137,
                "polygon": [
                  {
                    "x": 1152,
                    "y": 792
                  },
                  {
                    "x": 1283,
                    "y": 791
                  },
                  {
                    "x": 1283,
                    "y": 837
                  },
                  {
                    "x": 1152,
                    "y": 838
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_106",
                "text": ",",
                "paragraphIndex": 12,
                "confidence": 0.8301150798797607,
                "polygon": [
                  {
                    "x": 1293,
                    "y": 791
                  },
                  {
                    "x": 1320,
                    "y": 791
                  },
                  {
                    "x": 1320,
                    "y": 836
                  },
                  {
                    "x": 1293,
                    "y": 836
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_107",
                "text": "as",
                "paragraphIndex": 12,
                "confidence": 0.9860299825668335,
                "polygon": [
                  {
                    "x": 1330,
                    "y": 790
                  },
                  {
                    "x": 1399,
                    "y": 789
                  },
                  {
                    "x": 1399,
                    "y": 835
                  },
                  {
                    "x": 1330,
                    "y": 836
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_108",
                "text": "what",
                "paragraphIndex": 12,
                "confidence": 0.8521447777748108,
                "polygon": [
                  {
                    "x": 63,
                    "y": 867
                  },
                  {
                    "x": 223,
                    "y": 864
                  },
                  {
                    "x": 224,
                    "y": 915
                  },
                  {
                    "x": 64,
                    "y": 918
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_109",
                "text": "happen",
                "paragraphIndex": 12,
                "confidence": 0.8908218145370483,
                "polygon": [
                  {
                    "x": 251,
                    "y": 864
                  },
                  {
                    "x": 441,
                    "y": 861
                  },
                  {
                    "x": 442,
                    "y": 912
                  },
                  {
                    "x": 252,
                    "y": 915
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_110",
                "text": "to",
                "paragraphIndex": 12,
                "confidence": 0.9608196020126343,
                "polygon": [
                  {
                    "x": 475,
                    "y": 860
                  },
                  {
                    "x": 531,
                    "y": 859
                  },
                  {
                    "x": 532,
                    "y": 910
                  },
                  {
                    "x": 476,
                    "y": 911
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_111",
                "text": "MVS",
                "paragraphIndex": 12,
                "confidence": 0.30798962712287903,
                "polygon": [
                  {
                    "x": 550,
                    "y": 860
                  },
                  {
                    "x": 653,
                    "y": 858
                  },
                  {
                    "x": 654,
                    "y": 908
                  },
                  {
                    "x": 551,
                    "y": 910
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_112",
                "text": ",",
                "paragraphIndex": 12,
                "confidence": 0.5585878491401672,
                "polygon": [
                  {
                    "x": 644,
                    "y": 858
                  },
                  {
                    "x": 668,
                    "y": 858
                  },
                  {
                    "x": 669,
                    "y": 908
                  },
                  {
                    "x": 645,
                    "y": 908
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_113",
                "text": "Mallard",
                "paragraphIndex": 12,
                "confidence": 0.5660203099250793,
                "polygon": [
                  {
                    "x": 691,
                    "y": 857
                  },
                  {
                    "x": 894,
                    "y": 854
                  },
                  {
                    "x": 895,
                    "y": 905
                  },
                  {
                    "x": 692,
                    "y": 908
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_114",
                "text": "in",
                "paragraphIndex": 12,
                "confidence": 0.9848610758781433,
                "polygon": [
                  {
                    "x": 927,
                    "y": 853
                  },
                  {
                    "x": 976,
                    "y": 852
                  },
                  {
                    "x": 977,
                    "y": 902
                  },
                  {
                    "x": 928,
                    "y": 903
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_115",
                "text": "the",
                "paragraphIndex": 12,
                "confidence": 0.967386782169342,
                "polygon": [
                  {
                    "x": 1017,
                    "y": 852
                  },
                  {
                    "x": 1100,
                    "y": 851
                  },
                  {
                    "x": 1101,
                    "y": 901
                  },
                  {
                    "x": 1018,
                    "y": 902
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_116",
                "text": "story",
                "paragraphIndex": 12,
                "confidence": 0.936007022857666,
                "polygon": [
                  {
                    "x": 1121,
                    "y": 850
                  },
                  {
                    "x": 1286,
                    "y": 847
                  },
                  {
                    "x": 1287,
                    "y": 898
                  },
                  {
                    "x": 1122,
                    "y": 901
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_117",
                "text": ",",
                "paragraphIndex": 12,
                "confidence": 0.9406982660293579,
                "polygon": [
                  {
                    "x": 1282,
                    "y": 848
                  },
                  {
                    "x": 1308,
                    "y": 848
                  },
                  {
                    "x": 1309,
                    "y": 898
                  },
                  {
                    "x": 1283,
                    "y": 898
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_118",
                "text": "when",
                "paragraphIndex": 12,
                "confidence": 0.9890561103820801,
                "polygon": [
                  {
                    "x": 1322,
                    "y": 847
                  },
                  {
                    "x": 1444,
                    "y": 845
                  },
                  {
                    "x": 1445,
                    "y": 895
                  },
                  {
                    "x": 1323,
                    "y": 897
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_119",
                "text": "she",
                "paragraphIndex": 12,
                "confidence": 0.631269097328186,
                "polygon": [
                  {
                    "x": 59,
                    "y": 926
                  },
                  {
                    "x": 165,
                    "y": 925
                  },
                  {
                    "x": 166,
                    "y": 976
                  },
                  {
                    "x": 60,
                    "y": 977
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_120",
                "text": "recived",
                "paragraphIndex": 12,
                "confidence": 0.4723680913448334,
                "polygon": [
                  {
                    "x": 185,
                    "y": 925
                  },
                  {
                    "x": 374,
                    "y": 922
                  },
                  {
                    "x": 375,
                    "y": 972
                  },
                  {
                    "x": 186,
                    "y": 975
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_121",
                "text": "the",
                "paragraphIndex": 12,
                "confidence": 0.36192086338996887,
                "polygon": [
                  {
                    "x": 418,
                    "y": 921
                  },
                  {
                    "x": 515,
                    "y": 920
                  },
                  {
                    "x": 516,
                    "y": 971
                  },
                  {
                    "x": 419,
                    "y": 972
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_122",
                "text": "news",
                "paragraphIndex": 12,
                "confidence": 0.984359860420227,
                "polygon": [
                  {
                    "x": 552,
                    "y": 919
                  },
                  {
                    "x": 701,
                    "y": 917
                  },
                  {
                    "x": 702,
                    "y": 968
                  },
                  {
                    "x": 553,
                    "y": 970
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_123",
                "text": "of",
                "paragraphIndex": 12,
                "confidence": 0.9659945368766785,
                "polygon": [
                  {
                    "x": 735,
                    "y": 917
                  },
                  {
                    "x": 798,
                    "y": 916
                  },
                  {
                    "x": 799,
                    "y": 966
                  },
                  {
                    "x": 736,
                    "y": 967
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_124",
                "text": "her",
                "paragraphIndex": 12,
                "confidence": 0.903492271900177,
                "polygon": [
                  {
                    "x": 842,
                    "y": 916
                  },
                  {
                    "x": 947,
                    "y": 915
                  },
                  {
                    "x": 948,
                    "y": 965
                  },
                  {
                    "x": 843,
                    "y": 966
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_125",
                "text": "husband's",
                "paragraphIndex": 12,
                "confidence": 0.49745309352874756,
                "polygon": [
                  {
                    "x": 975,
                    "y": 914
                  },
                  {
                    "x": 1215,
                    "y": 911
                  },
                  {
                    "x": 1216,
                    "y": 962
                  },
                  {
                    "x": 976,
                    "y": 965
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_126",
                "text": "alliged",
                "paragraphIndex": 12,
                "confidence": 0.7448129057884216,
                "polygon": [
                  {
                    "x": 1233,
                    "y": 910
                  },
                  {
                    "x": 1443,
                    "y": 907
                  },
                  {
                    "x": 1444,
                    "y": 958
                  },
                  {
                    "x": 1234,
                    "y": 961
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_127",
                "text": "death",
                "paragraphIndex": 12,
                "confidence": 0.8939012885093689,
                "polygon": [
                  {
                    "x": 68,
                    "y": 992
                  },
                  {
                    "x": 223,
                    "y": 989
                  },
                  {
                    "x": 224,
                    "y": 1039
                  },
                  {
                    "x": 69,
                    "y": 1042
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_128",
                "text": ".",
                "paragraphIndex": 12,
                "confidence": 0.42966264486312866,
                "polygon": [
                  {
                    "x": 224,
                    "y": 990
                  },
                  {
                    "x": 262,
                    "y": 989
                  },
                  {
                    "x": 263,
                    "y": 1038
                  },
                  {
                    "x": 225,
                    "y": 1039
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_129",
                "text": "She",
                "paragraphIndex": 12,
                "confidence": 0.8872808814048767,
                "polygon": [
                  {
                    "x": 248,
                    "y": 989
                  },
                  {
                    "x": 356,
                    "y": 987
                  },
                  {
                    "x": 357,
                    "y": 1037
                  },
                  {
                    "x": 249,
                    "y": 1039
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_130",
                "text": "greever",
                "paragraphIndex": 12,
                "confidence": 0.6019262075424194,
                "polygon": [
                  {
                    "x": 373,
                    "y": 987
                  },
                  {
                    "x": 557,
                    "y": 984
                  },
                  {
                    "x": 558,
                    "y": 1034
                  },
                  {
                    "x": 374,
                    "y": 1037
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_131",
                "text": ",",
                "paragraphIndex": 12,
                "confidence": 0.8449642062187195,
                "polygon": [
                  {
                    "x": 566,
                    "y": 984
                  },
                  {
                    "x": 592,
                    "y": 984
                  },
                  {
                    "x": 593,
                    "y": 1033
                  },
                  {
                    "x": 567,
                    "y": 1033
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_132",
                "text": "yes",
                "paragraphIndex": 12,
                "confidence": 0.944663941860199,
                "polygon": [
                  {
                    "x": 612,
                    "y": 983
                  },
                  {
                    "x": 705,
                    "y": 981
                  },
                  {
                    "x": 706,
                    "y": 1031
                  },
                  {
                    "x": 613,
                    "y": 1033
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_133",
                "text": ",",
                "paragraphIndex": 12,
                "confidence": 0.8297369480133057,
                "polygon": [
                  {
                    "x": 706,
                    "y": 982
                  },
                  {
                    "x": 733,
                    "y": 982
                  },
                  {
                    "x": 734,
                    "y": 1031
                  },
                  {
                    "x": 707,
                    "y": 1031
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_134",
                "text": "but",
                "paragraphIndex": 12,
                "confidence": 0.9307929873466492,
                "polygon": [
                  {
                    "x": 749,
                    "y": 981
                  },
                  {
                    "x": 853,
                    "y": 979
                  },
                  {
                    "x": 854,
                    "y": 1029
                  },
                  {
                    "x": 750,
                    "y": 1031
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_135",
                "text": "after",
                "paragraphIndex": 12,
                "confidence": 0.9783305525779724,
                "polygon": [
                  {
                    "x": 882,
                    "y": 979
                  },
                  {
                    "x": 1058,
                    "y": 976
                  },
                  {
                    "x": 1059,
                    "y": 1026
                  },
                  {
                    "x": 883,
                    "y": 1029
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_136",
                "text": "a",
                "paragraphIndex": 12,
                "confidence": 0.9888032674789429,
                "polygon": [
                  {
                    "x": 1067,
                    "y": 976
                  },
                  {
                    "x": 1107,
                    "y": 975
                  },
                  {
                    "x": 1108,
                    "y": 1024
                  },
                  {
                    "x": 1068,
                    "y": 1025
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_137",
                "text": "while",
                "paragraphIndex": 12,
                "confidence": 0.9500046968460083,
                "polygon": [
                  {
                    "x": 1135,
                    "y": 975
                  },
                  {
                    "x": 1268,
                    "y": 973
                  },
                  {
                    "x": 1269,
                    "y": 1022
                  },
                  {
                    "x": 1136,
                    "y": 1024
                  }
                ],
                "bbox": null
              },
              {
                "id": "word_1_138",
                "text": "she",
                "paragraphIndex": 12,
                "confidence": 0.9746686816215515,
                "polygon": [
                  {
                    "x": 1299,
                    "y": 972
                  },
                  {
                    "x": 1406,
                    "y": 970
                  },
                  {
                    "x": 1407,
                    "y": 1020
                  },
                  {
                    "x": 1300,
                    "y": 1022
                  }
                ],
                "bbox": null
              }
            ]
          }
        ]
      },
      "existingDiagnostics": [
        {
          "category": "INSERTION_DELETION",
          "start": 95,
          "evidenceScope": "WHOLE_ACTIVE_TRANSCRIPT",
          "astraValue": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of Self?\nSocial and cultural expectations shape\nLouise Mallard because in her social and cultural\ncontext,  women, such as her self, are expected\nto  divote their lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis Self-nigleacting way of living will eventually\nshift the  of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived  news of her husbends alliged\ndeath. She greever, yes, but after a while she",
          "fableValue": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of self ?\nSocial and cultural expectations shape\nLouise Mallard because In her social and cultural\ncontext, marrid wemen, such as her self, are expected\nto divote there lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis self-nigleacting way of living will eventually\nshift The judjment of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived the news of her husbend's alliged\ndeath. She greeved, yes, but after a while she",
          "limitation": "Stored diagnostic is coarse; exact regions are recomputed separately. It is not one source error."
        },
        {
          "category": "SPELLING_LEXICAL",
          "start": 95,
          "evidenceScope": "WHOLE_ACTIVE_TRANSCRIPT",
          "astraValue": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of Self?\nSocial and cultural expectations shape\nLouise Mallard because in her social and cultural\ncontext,  women, such as her self, are expected\nto  divote their lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis Self-nigleacting way of living will eventually\nshift the  of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived  news of her husbends alliged\ndeath. She greever, yes, but after a while she",
          "fableValue": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of self ?\nSocial and cultural expectations shape\nLouise Mallard because In her social and cultural\ncontext, marrid wemen, such as her self, are expected\nto divote there lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis self-nigleacting way of living will eventually\nshift The judjment of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived the news of her husbend's alliged\ndeath. She greeved, yes, but after a while she",
          "limitation": "Stored diagnostic is coarse; exact regions are recomputed separately. It is not one source error."
        },
        {
          "category": "SEGMENT_CLASSIFICATION_OR_TEXT",
          "start": null,
          "evidenceScope": "ORDERED_SEGMENT_SIGNATURE",
          "astraValue": [
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "How do social and cultural expectations",
              "confidence": 0.94,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "shape Louise Marllard's choices, feelings and",
              "confidence": 0.86,
              "notes": "The additional strokes in the surname are retained."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "sence of Self?",
              "confidence": 0.87,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "Social and cultural expectations shape",
              "confidence": 0.93,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "Louise Mallard because in her social and cultural",
              "confidence": 0.9,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "context,  women, such as her self, are expected",
              "confidence": 0.89,
              "notes": "The uncertain word between 'context,' and 'women' is excluded."
            },
            {
              "type": "UNCERTAIN",
              "text": null,
              "confidence": 0.43,
              "notes": "The word before 'women' contains crowded, indistinct letter strokes."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "to  divote their lifes to there houses, husbends,",
              "confidence": 0.83,
              "notes": "The uncertain span after the initial 'to' is excluded. The inserted 'to' above the crossed-out word is included in reading order."
            },
            {
              "type": "UNCERTAIN",
              "text": "be",
              "confidence": 0.58,
              "notes": "The short span after the initial 'to' resembles 'be', but heavy strokes make its deletion status unclear."
            },
            {
              "type": "CROSSED_OUT_OR_DELETED",
              "text": "for",
              "confidence": 0.84,
              "notes": "Crossed out after 'lifes', with 'to' written above."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "and family in a way that make Them forget how",
              "confidence": 0.9,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "to live a little, and to take care of them selfes",
              "confidence": 0.89,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "insted of others, wich is a neccity for humens.",
              "confidence": 0.85,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "This Self-nigleacting way of living will eventually",
              "confidence": 0.85,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "shift the  of any human begin, as",
              "confidence": 0.88,
              "notes": "The uncertain word between 'the' and 'of' is excluded."
            },
            {
              "type": "UNCERTAIN",
              "text": null,
              "confidence": 0.55,
              "notes": "The word after 'the' has an indistinct sequence of medial and final strokes."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "what happen to Mrs. Mallard in the story, when",
              "confidence": 0.9,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "she recived  news of her husbends alliged",
              "confidence": 0.86,
              "notes": "The uncertain word before 'news' is excluded."
            },
            {
              "type": "UNCERTAIN",
              "text": null,
              "confidence": 0.5,
              "notes": "The word before 'news' resembles 'me'; the initial strokes could also be joined 'th'."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "death. She greever, yes, but after a while she",
              "confidence": 0.83,
              "notes": "The visible wording ends at 'she'."
            }
          ],
          "fableValue": [
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "How do social and cultural expectations",
              "confidence": 0.95,
              "notes": "Handwritten prompt/question line copied by the student at top of page."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "shape Louise Marllard's choices, feelings and",
              "confidence": 0.92,
              "notes": "Surname visibly written with 'r' before 'll' (Marllard's)."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "sence of self ?",
              "confidence": 0.93,
              "notes": "Space before question mark as visible."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "Social and cultural expectations shape",
              "confidence": 0.95,
              "notes": "Indented first line of response."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "Louise Mallard because In her social and cultural",
              "confidence": 0.93,
              "notes": "'In' appears with a capital-looking I."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "context, marrid wemen, such as her self, are expected",
              "confidence": 0.75,
              "notes": "'context' and 'marrid' glyphs partly ambiguous; see uncertainSpans. 'expected' runs to the page edge."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "to divote there lifes to there houses, husbends,",
              "confidence": 0.85,
              "notes": "Word after 'to' is struck through (see deleted segment). 'for' struck through with 'to' written above it; active reading uses 'to'."
            },
            {
              "type": "CROSSED_OUT_OR_DELETED",
              "text": "be",
              "confidence": 0.8,
              "notes": "Struck-through word between 'to' and 'divote'."
            },
            {
              "type": "CROSSED_OUT_OR_DELETED",
              "text": "for",
              "confidence": 0.85,
              "notes": "Struck-through word replaced by superscript 'to'."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "and family in a way that make Them forget how",
              "confidence": 0.92,
              "notes": "'Them' appears with capital T."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "to live a little, and to take care of them selfes",
              "confidence": 0.9,
              "notes": "'them selfes' written as two words."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "insted of others, wich is a neccity for humens.",
              "confidence": 0.88,
              "notes": "'neccity' read from glyphs; possible 'necciity' but double c clear."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "This self-nigleacting way of living will eventually",
              "confidence": 0.85,
              "notes": "'nigleacting' read as written; 'eventually' has slight gap mid-word."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "shift The judjment of any human begin, as",
              "confidence": 0.75,
              "notes": "'judjment' glyphs ambiguous; 'The' capitalized; 'begin' as written."
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "what happen to Mrs. Mallard in the story, when",
              "confidence": 0.93,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "she recived the news of her husbend's alliged",
              "confidence": 0.9,
              "notes": ""
            },
            {
              "type": "ACTIVE_STUDENT_TEXT",
              "text": "death. She greeved, yes, but after a while she",
              "confidence": 0.85,
              "notes": "'greeved' final letters slightly looped; could read 'greevel'."
            }
          ],
          "limitation": "Stored diagnostic is coarse; exact regions are recomputed separately. It is not one source error."
        }
      ],
      "targeted": {
        "version": "targeted-source-v2",
        "firstPassStatus": "OCR_UNCERTAIN",
        "status": "OCR_UNCERTAIN",
        "stage": "OCR_UNCERTAIN",
        "text": "How do social and cultural expectations\nshape Louise Marllard's choices, feelings and\nsence of Self?\nSocial and cultural expectations shape\nLouise Mallard because in her social and cultural\ncontext,  women, such as her self, are expected\nto  divote their lifes to there houses, husbends,\nand family in a way that make Them forget how\nto live a little, and to take care of them selfes\ninsted of others, wich is a neccity for humens.\nThis Self-nigleacting way of living will eventually\nshift the  of any human begin, as\nwhat happen to Mrs. Mallard in the story, when\nshe recived  news of her husbends alliged\ndeath. She greever, yes, but after a while she",
        "plan": {
          "candidateRegionCount": 10,
          "omittedRegionCount": 2,
          "unlocalizedSignalCount": 3,
          "reasonCodes": [
            "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
            "ASTRA_FABLE_TEXT_DISAGREEMENT",
            "GEOMETRY_COVERAGE_GAP",
            "POSSIBLE_READER_OMISSION",
            "READER_UNCERTAIN_SPAN"
          ],
          "signals": [
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_16"
              ],
              "origin": {
                "reader": "both",
                "start": 95,
                "end": 99
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_26"
              ],
              "origin": {
                "reader": "both",
                "start": 163,
                "end": 165
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_35",
                "word_1_36"
              ],
              "origin": {
                "reader": "both",
                "start": 198,
                "end": 205
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_47"
              ],
              "origin": {
                "reader": "both",
                "start": 240,
                "end": 242
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_48"
              ],
              "origin": {
                "reader": "both",
                "start": 249,
                "end": 254
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_90"
              ],
              "origin": {
                "reader": "both",
                "start": 437,
                "end": 441
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_100",
                "word_1_101"
              ],
              "origin": {
                "reader": "both",
                "start": 490,
                "end": 495
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_121"
              ],
              "origin": {
                "reader": "both",
                "start": 576,
                "end": 578
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_125"
              ],
              "origin": {
                "reader": "both",
                "start": 590,
                "end": 598
              }
            },
            {
              "reason": "ASTRA_FABLE_TEXT_DISAGREEMENT",
              "ids": [
                "word_1_130"
              ],
              "origin": {
                "reader": "both",
                "start": 618,
                "end": 625
              }
            },
            {
              "reason": "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
              "ids": [],
              "origin": {
                "reader": 0,
                "type": "UNCERTAIN"
              }
            },
            {
              "reason": "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
              "ids": [
                "word_1_46"
              ],
              "origin": {
                "reader": 0,
                "type": "UNCERTAIN"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_46"
              ],
              "origin": {
                "reader": 0,
                "type": "UNCERTAIN"
              }
            },
            {
              "reason": "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
              "ids": [],
              "origin": {
                "reader": 0,
                "type": "UNCERTAIN"
              }
            },
            {
              "reason": "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
              "ids": [],
              "origin": {
                "reader": 0,
                "type": "UNCERTAIN"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_33",
                "word_1_34",
                "word_1_35"
              ],
              "origin": {
                "reader": 0,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_47"
              ],
              "origin": {
                "reader": 0,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_99",
                "word_1_100",
                "word_1_102",
                "word_1_103",
                "word_1_104",
                "word_1_105"
              ],
              "origin": {
                "reader": 0,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_119",
                "word_1_120",
                "word_1_122"
              ],
              "origin": {
                "reader": 0,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_31",
                "word_1_32"
              ],
              "origin": {
                "reader": 0,
                "type": "GEOMETRY_COVERAGE_GAP"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_35",
                "word_1_36"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "POSSIBLE_READER_OMISSION",
              "ids": [
                "word_1_35",
                "word_1_36"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_46"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "POSSIBLE_READER_OMISSION",
              "ids": [
                "word_1_46"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_55"
              ],
              "origin": {
                "reader": 0,
                "type": "GEOMETRY_COVERAGE_GAP"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_78",
                "word_1_79"
              ],
              "origin": {
                "reader": 0,
                "type": "GEOMETRY_COVERAGE_GAP"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_100",
                "word_1_101"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "POSSIBLE_READER_OMISSION",
              "ids": [
                "word_1_100",
                "word_1_101"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_121"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "POSSIBLE_READER_OMISSION",
              "ids": [
                "word_1_121"
              ],
              "origin": {
                "reader": 0,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
              "ids": [
                "word_1_46"
              ],
              "origin": {
                "reader": 1,
                "type": "CROSSED_OUT_OR_DELETED"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_33",
                "word_1_34",
                "word_1_35",
                "word_1_36",
                "word_1_37",
                "word_1_38",
                "word_1_39",
                "word_1_40",
                "word_1_41",
                "word_1_42",
                "word_1_43",
                "word_1_44"
              ],
              "origin": {
                "reader": 1,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_33",
                "word_1_34",
                "word_1_35",
                "word_1_36",
                "word_1_37",
                "word_1_38",
                "word_1_39",
                "word_1_40",
                "word_1_41"
              ],
              "origin": {
                "reader": 1,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_45",
                "word_1_47",
                "word_1_48",
                "word_1_49",
                "word_1_50",
                "word_1_51",
                "word_1_52"
              ],
              "origin": {
                "reader": 1,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_99",
                "word_1_100",
                "word_1_101",
                "word_1_102",
                "word_1_103",
                "word_1_104",
                "word_1_105"
              ],
              "origin": {
                "reader": 1,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "READER_UNCERTAIN_SPAN",
              "ids": [
                "word_1_127",
                "word_1_128",
                "word_1_129",
                "word_1_130",
                "word_1_131",
                "word_1_132"
              ],
              "origin": {
                "reader": 1,
                "type": "EXPLICIT_UNCERTAINTY"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_31",
                "word_1_32"
              ],
              "origin": {
                "reader": 1,
                "type": "GEOMETRY_COVERAGE_GAP"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_46"
              ],
              "origin": {
                "reader": 1,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "POSSIBLE_READER_OMISSION",
              "ids": [
                "word_1_46"
              ],
              "origin": {
                "reader": 1,
                "type": "POSSIBLE_READER_OMISSION"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_55"
              ],
              "origin": {
                "reader": 1,
                "type": "GEOMETRY_COVERAGE_GAP"
              }
            },
            {
              "reason": "GEOMETRY_COVERAGE_GAP",
              "ids": [
                "word_1_78",
                "word_1_79"
              ],
              "origin": {
                "reader": 1,
                "type": "GEOMETRY_COVERAGE_GAP"
              }
            }
          ],
          "regions": [
            {
              "id": "4e26e4964ba0f99f59ec2f5dd34d76da8ad5d69feb7a6f0a264151b4d4667a24",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT"
              ],
              "lineIds": [
                5
              ],
              "nativeCoordinates": {
                "left": 269,
                "top": 176,
                "width": 304,
                "height": 69
              },
              "displayCoordinates": {
                "left": 269,
                "top": 176,
                "width": 304,
                "height": 69
              },
              "sourceGeometryWordIds": [
                "word_1_15",
                "word_1_16",
                "word_1_17"
              ],
              "leftAnchorId": "word_1_15",
              "rightAnchorId": "word_1_17",
              "cropSha256": "ddeb825495314eaee4ccd161242b6f87581dd70c0e40ee5b91607b43474e58de",
              "cropDimensions": {
                "width": 304,
                "height": 69
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 269,
                "offsetY": 176,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            {
              "id": "9184674af8ac2bc6d013e2315002efb2cc8c1570f10fddae16e97849bd75177d",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT"
              ],
              "lineIds": [
                7
              ],
              "nativeCoordinates": {
                "left": 51,
                "top": 353,
                "width": 1504,
                "height": 82
              },
              "displayCoordinates": {
                "left": 51,
                "top": 353,
                "width": 1504,
                "height": 82
              },
              "sourceGeometryWordIds": [
                "word_1_23",
                "word_1_24",
                "word_1_25",
                "word_1_26",
                "word_1_27",
                "word_1_28",
                "word_1_29",
                "word_1_30"
              ],
              "leftAnchorId": "word_1_23",
              "rightAnchorId": "word_1_30",
              "cropSha256": "e60e862c9d4c31ccd79755c991aeb77ac13da485099e53b94bcfbed4a5e38cb6",
              "cropDimensions": {
                "width": 1504,
                "height": 82
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 51,
                "offsetY": 353,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "UNIQUE_STRUCTURAL_SPAN",
                "start": 140,
                "end": 189,
                "original": "Louise Mallard because in her social and cultural",
                "leftAnchor": "Louise",
                "rightAnchor": "cultural",
                "leftAnchorId": "word_1_23",
                "rightAnchorId": "word_1_30",
                "sourceTranscriptSha256": "1f95992021575e9943279983a83ea306247a8dadf7cb39be02004ac08902cd99"
              }
            },
            {
              "id": "c9e23d42fa487a71f3c929847acfc319cfe0cfa146767eb4a45aded2e1d15c3e",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT",
                "GEOMETRY_COVERAGE_GAP",
                "POSSIBLE_READER_OMISSION",
                "READER_UNCERTAIN_SPAN"
              ],
              "lineIds": [
                10
              ],
              "nativeCoordinates": {
                "left": 31,
                "top": 409,
                "width": 1554,
                "height": 93
              },
              "displayCoordinates": {
                "left": 31,
                "top": 409,
                "width": 1554,
                "height": 93
              },
              "sourceGeometryWordIds": [
                "word_1_33",
                "word_1_34",
                "word_1_35",
                "word_1_36",
                "word_1_37",
                "word_1_38",
                "word_1_39",
                "word_1_40",
                "word_1_41",
                "word_1_42",
                "word_1_43",
                "word_1_44"
              ],
              "leftAnchorId": "word_1_33",
              "rightAnchorId": "word_1_44",
              "cropSha256": "b539c24aebf589b0db6586c6fc26f6872c6a7873a3c5b99746c43cb10a27b262",
              "cropDimensions": {
                "width": 1554,
                "height": 93
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 31,
                "offsetY": 409,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "UNIQUE_STRUCTURAL_SPAN",
                "start": 190,
                "end": 237,
                "original": "context,  women, such as her self, are expected",
                "leftAnchor": "context",
                "rightAnchor": "expected",
                "leftAnchorId": "word_1_33",
                "rightAnchorId": "word_1_44",
                "sourceTranscriptSha256": "1f95992021575e9943279983a83ea306247a8dadf7cb39be02004ac08902cd99"
              }
            },
            {
              "id": "9d823cc07ea1c583252a1a02a291d3e574e2cd03590e10ecb8d339b5d260c676",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
                "ASTRA_FABLE_TEXT_DISAGREEMENT",
                "GEOMETRY_COVERAGE_GAP",
                "POSSIBLE_READER_OMISSION",
                "READER_UNCERTAIN_SPAN"
              ],
              "lineIds": [
                8,
                11,
                9
              ],
              "nativeCoordinates": {
                "left": 50,
                "top": 476,
                "width": 1487,
                "height": 86
              },
              "displayCoordinates": {
                "left": 50,
                "top": 476,
                "width": 1487,
                "height": 86
              },
              "sourceGeometryWordIds": [
                "word_1_31",
                "word_1_45",
                "word_1_46",
                "word_1_47",
                "word_1_48",
                "word_1_49",
                "word_1_50",
                "word_1_51",
                "word_1_52",
                "word_1_53",
                "word_1_54",
                "word_1_55",
                "word_1_56",
                "word_1_32"
              ],
              "leftAnchorId": "word_1_31",
              "rightAnchorId": "word_1_31",
              "cropSha256": "445f0d397856616de6d0b8a893577f5b1f66ce473993f0d9315835062d510d10",
              "cropDimensions": {
                "width": 1487,
                "height": 86
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 50,
                "offsetY": 476,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            {
              "id": "26972fedd03e50ea07b3703b0b1eba406b769d878f93b09b3b1c651e900d314b",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "GEOMETRY_COVERAGE_GAP"
              ],
              "lineIds": [
                14
              ],
              "nativeCoordinates": {
                "left": 484,
                "top": 570,
                "width": 50,
                "height": 38
              },
              "displayCoordinates": {
                "left": 484,
                "top": 570,
                "width": 50,
                "height": 38
              },
              "sourceGeometryWordIds": [
                "word_1_78"
              ],
              "leftAnchorId": "word_1_78",
              "rightAnchorId": "word_1_78",
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            {
              "id": "0504676196679fb4def6f2ee41fc7e4c47b967af416cf388c9f67efe3212e77b",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "GEOMETRY_COVERAGE_GAP"
              ],
              "lineIds": [
                15
              ],
              "nativeCoordinates": {
                "left": 846,
                "top": 688,
                "width": 44,
                "height": 28
              },
              "displayCoordinates": {
                "left": 846,
                "top": 688,
                "width": 44,
                "height": 28
              },
              "sourceGeometryWordIds": [
                "word_1_79"
              ],
              "leftAnchorId": "word_1_79",
              "rightAnchorId": "word_1_79",
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            {
              "id": "e106ff2caecaaca3b069c77877df0733a3e27bf67aed0a35bd46eda90cabb26d",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT"
              ],
              "lineIds": [
                17
              ],
              "nativeCoordinates": {
                "left": 39,
                "top": 718,
                "width": 1501,
                "height": 91
              },
              "displayCoordinates": {
                "left": 39,
                "top": 718,
                "width": 1501,
                "height": 91
              },
              "sourceGeometryWordIds": [
                "word_1_89",
                "word_1_90",
                "word_1_91",
                "word_1_92",
                "word_1_93",
                "word_1_94",
                "word_1_95",
                "word_1_96",
                "word_1_97",
                "word_1_98"
              ],
              "leftAnchorId": "word_1_89",
              "rightAnchorId": "word_1_98",
              "cropSha256": "7a5d92dcaa98d7a89548d1b5ea0c1b3b6d3f69590e1a472958b61b0aa61b7b17",
              "cropDimensions": {
                "width": 1501,
                "height": 91
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 39,
                "offsetY": 718,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            {
              "id": "6c078b9c1e0e31f0eb2e5a8d055eb88c02950e10032eefd0db8307ccfb7bfe9d",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT",
                "GEOMETRY_COVERAGE_GAP",
                "POSSIBLE_READER_OMISSION",
                "READER_UNCERTAIN_SPAN"
              ],
              "lineIds": [
                18
              ],
              "nativeCoordinates": {
                "left": 45,
                "top": 779,
                "width": 1364,
                "height": 80
              },
              "displayCoordinates": {
                "left": 45,
                "top": 779,
                "width": 1364,
                "height": 80
              },
              "sourceGeometryWordIds": [
                "word_1_99",
                "word_1_100",
                "word_1_101",
                "word_1_102",
                "word_1_103",
                "word_1_104",
                "word_1_105",
                "word_1_106",
                "word_1_107"
              ],
              "leftAnchorId": "word_1_99",
              "rightAnchorId": "word_1_107",
              "cropSha256": "8c4624c2e082aaf9db72b20a34d712191cb94910cad655b8b8386b4e36ee2c82",
              "cropDimensions": {
                "width": 1364,
                "height": 80
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 45,
                "offsetY": 779,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "UNIQUE_STRUCTURAL_SPAN",
                "start": 484,
                "end": 517,
                "original": "shift the  of any human begin, as",
                "leftAnchor": "shift",
                "rightAnchor": "as",
                "leftAnchorId": "word_1_99",
                "rightAnchorId": "word_1_107",
                "sourceTranscriptSha256": "1f95992021575e9943279983a83ea306247a8dadf7cb39be02004ac08902cd99"
              }
            }
          ]
        },
        "results": [
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "region": {
              "id": "4e26e4964ba0f99f59ec2f5dd34d76da8ad5d69feb7a6f0a264151b4d4667a24",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT"
              ],
              "lineIds": [
                5
              ],
              "nativeCoordinates": {
                "left": 269,
                "top": 176,
                "width": 304,
                "height": 69
              },
              "displayCoordinates": {
                "left": 269,
                "top": 176,
                "width": 304,
                "height": 69
              },
              "sourceGeometryWordIds": [
                "word_1_15",
                "word_1_16",
                "word_1_17"
              ],
              "leftAnchorId": "word_1_15",
              "rightAnchorId": "word_1_17",
              "cropSha256": "ddeb825495314eaee4ccd161242b6f87581dd70c0e40ee5b91607b43474e58de",
              "cropDimensions": {
                "width": 304,
                "height": 69
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 269,
                "offsetY": 176,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            "readers": [
              {
                "model": "openai/gpt-6-astra",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "ddeb825495314eaee4ccd161242b6f87581dd70c0e40ee5b91607b43474e58de",
                "durationMs": null,
                "value": null,
                "usage": {}
              },
              {
                "model": "anthropic/claude-fable-5.1",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "ddeb825495314eaee4ccd161242b6f87581dd70c0e40ee5b91607b43474e58de",
                "durationMs": null,
                "value": null,
                "usage": {}
              }
            ],
            "reconciliation": null
          },
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "region": {
              "id": "9184674af8ac2bc6d013e2315002efb2cc8c1570f10fddae16e97849bd75177d",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT"
              ],
              "lineIds": [
                7
              ],
              "nativeCoordinates": {
                "left": 51,
                "top": 353,
                "width": 1504,
                "height": 82
              },
              "displayCoordinates": {
                "left": 51,
                "top": 353,
                "width": 1504,
                "height": 82
              },
              "sourceGeometryWordIds": [
                "word_1_23",
                "word_1_24",
                "word_1_25",
                "word_1_26",
                "word_1_27",
                "word_1_28",
                "word_1_29",
                "word_1_30"
              ],
              "leftAnchorId": "word_1_23",
              "rightAnchorId": "word_1_30",
              "cropSha256": "e60e862c9d4c31ccd79755c991aeb77ac13da485099e53b94bcfbed4a5e38cb6",
              "cropDimensions": {
                "width": 1504,
                "height": 82
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 51,
                "offsetY": 353,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "UNIQUE_STRUCTURAL_SPAN",
                "start": 140,
                "end": 189,
                "original": "Louise Mallard because in her social and cultural",
                "leftAnchor": "Louise",
                "rightAnchor": "cultural",
                "leftAnchorId": "word_1_23",
                "rightAnchorId": "word_1_30",
                "sourceTranscriptSha256": "1f95992021575e9943279983a83ea306247a8dadf7cb39be02004ac08902cd99"
              }
            },
            "readers": [
              {
                "model": "openai/gpt-6-astra",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "e60e862c9d4c31ccd79755c991aeb77ac13da485099e53b94bcfbed4a5e38cb6",
                "durationMs": null,
                "value": null,
                "usage": {}
              },
              {
                "model": "anthropic/claude-fable-5.1",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "e60e862c9d4c31ccd79755c991aeb77ac13da485099e53b94bcfbed4a5e38cb6",
                "durationMs": null,
                "value": null,
                "usage": {}
              }
            ],
            "reconciliation": null
          },
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "region": {
              "id": "c9e23d42fa487a71f3c929847acfc319cfe0cfa146767eb4a45aded2e1d15c3e",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT",
                "GEOMETRY_COVERAGE_GAP",
                "POSSIBLE_READER_OMISSION",
                "READER_UNCERTAIN_SPAN"
              ],
              "lineIds": [
                10
              ],
              "nativeCoordinates": {
                "left": 31,
                "top": 409,
                "width": 1554,
                "height": 93
              },
              "displayCoordinates": {
                "left": 31,
                "top": 409,
                "width": 1554,
                "height": 93
              },
              "sourceGeometryWordIds": [
                "word_1_33",
                "word_1_34",
                "word_1_35",
                "word_1_36",
                "word_1_37",
                "word_1_38",
                "word_1_39",
                "word_1_40",
                "word_1_41",
                "word_1_42",
                "word_1_43",
                "word_1_44"
              ],
              "leftAnchorId": "word_1_33",
              "rightAnchorId": "word_1_44",
              "cropSha256": "b539c24aebf589b0db6586c6fc26f6872c6a7873a3c5b99746c43cb10a27b262",
              "cropDimensions": {
                "width": 1554,
                "height": 93
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 31,
                "offsetY": 409,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "UNIQUE_STRUCTURAL_SPAN",
                "start": 190,
                "end": 237,
                "original": "context,  women, such as her self, are expected",
                "leftAnchor": "context",
                "rightAnchor": "expected",
                "leftAnchorId": "word_1_33",
                "rightAnchorId": "word_1_44",
                "sourceTranscriptSha256": "1f95992021575e9943279983a83ea306247a8dadf7cb39be02004ac08902cd99"
              }
            },
            "readers": [
              {
                "model": "openai/gpt-6-astra",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "b539c24aebf589b0db6586c6fc26f6872c6a7873a3c5b99746c43cb10a27b262",
                "durationMs": null,
                "value": null,
                "usage": {}
              },
              {
                "model": "anthropic/claude-fable-5.1",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "b539c24aebf589b0db6586c6fc26f6872c6a7873a3c5b99746c43cb10a27b262",
                "durationMs": null,
                "value": null,
                "usage": {}
              }
            ],
            "reconciliation": null
          },
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "region": {
              "id": "9d823cc07ea1c583252a1a02a291d3e574e2cd03590e10ecb8d339b5d260c676",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
                "ASTRA_FABLE_TEXT_DISAGREEMENT",
                "GEOMETRY_COVERAGE_GAP",
                "POSSIBLE_READER_OMISSION",
                "READER_UNCERTAIN_SPAN"
              ],
              "lineIds": [
                8,
                11,
                9
              ],
              "nativeCoordinates": {
                "left": 50,
                "top": 476,
                "width": 1487,
                "height": 86
              },
              "displayCoordinates": {
                "left": 50,
                "top": 476,
                "width": 1487,
                "height": 86
              },
              "sourceGeometryWordIds": [
                "word_1_31",
                "word_1_45",
                "word_1_46",
                "word_1_47",
                "word_1_48",
                "word_1_49",
                "word_1_50",
                "word_1_51",
                "word_1_52",
                "word_1_53",
                "word_1_54",
                "word_1_55",
                "word_1_56",
                "word_1_32"
              ],
              "leftAnchorId": "word_1_31",
              "rightAnchorId": "word_1_31",
              "cropSha256": "445f0d397856616de6d0b8a893577f5b1f66ce473993f0d9315835062d510d10",
              "cropDimensions": {
                "width": 1487,
                "height": 86
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 50,
                "offsetY": 476,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            "readers": [
              {
                "model": "openai/gpt-6-astra",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "445f0d397856616de6d0b8a893577f5b1f66ce473993f0d9315835062d510d10",
                "durationMs": null,
                "value": null,
                "usage": {}
              },
              {
                "model": "anthropic/claude-fable-5.1",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "445f0d397856616de6d0b8a893577f5b1f66ce473993f0d9315835062d510d10",
                "durationMs": null,
                "value": null,
                "usage": {}
              }
            ],
            "reconciliation": null
          },
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "failureCode": "OCR_TARGETED_CROP_FAILED",
            "region": {
              "id": "26972fedd03e50ea07b3703b0b1eba406b769d878f93b09b3b1c651e900d314b",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "GEOMETRY_COVERAGE_GAP"
              ],
              "lineIds": [
                14
              ],
              "nativeCoordinates": {
                "left": 484,
                "top": 570,
                "width": 50,
                "height": 38
              },
              "displayCoordinates": {
                "left": 484,
                "top": 570,
                "width": 50,
                "height": 38
              },
              "sourceGeometryWordIds": [
                "word_1_78"
              ],
              "leftAnchorId": "word_1_78",
              "rightAnchorId": "word_1_78",
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            "readers": [],
            "reconciliation": null
          },
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "failureCode": "OCR_TARGETED_CROP_FAILED",
            "region": {
              "id": "0504676196679fb4def6f2ee41fc7e4c47b967af416cf388c9f67efe3212e77b",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "GEOMETRY_COVERAGE_GAP"
              ],
              "lineIds": [
                15
              ],
              "nativeCoordinates": {
                "left": 846,
                "top": 688,
                "width": 44,
                "height": 28
              },
              "displayCoordinates": {
                "left": 846,
                "top": 688,
                "width": 44,
                "height": 28
              },
              "sourceGeometryWordIds": [
                "word_1_79"
              ],
              "leftAnchorId": "word_1_79",
              "rightAnchorId": "word_1_79",
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            "readers": [],
            "reconciliation": null
          },
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "region": {
              "id": "e106ff2caecaaca3b069c77877df0733a3e27bf67aed0a35bd46eda90cabb26d",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT"
              ],
              "lineIds": [
                17
              ],
              "nativeCoordinates": {
                "left": 39,
                "top": 718,
                "width": 1501,
                "height": 91
              },
              "displayCoordinates": {
                "left": 39,
                "top": 718,
                "width": 1501,
                "height": 91
              },
              "sourceGeometryWordIds": [
                "word_1_89",
                "word_1_90",
                "word_1_91",
                "word_1_92",
                "word_1_93",
                "word_1_94",
                "word_1_95",
                "word_1_96",
                "word_1_97",
                "word_1_98"
              ],
              "leftAnchorId": "word_1_89",
              "rightAnchorId": "word_1_98",
              "cropSha256": "7a5d92dcaa98d7a89548d1b5ea0c1b3b6d3f69590e1a472958b61b0aa61b7b17",
              "cropDimensions": {
                "width": 1501,
                "height": 91
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 39,
                "offsetY": 718,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "MAPPING_WITHHELD"
              }
            },
            "readers": [
              {
                "model": "openai/gpt-6-astra",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "7a5d92dcaa98d7a89548d1b5ea0c1b3b6d3f69590e1a472958b61b0aa61b7b17",
                "durationMs": null,
                "value": null,
                "usage": {}
              },
              {
                "model": "anthropic/claude-fable-5.1",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "7a5d92dcaa98d7a89548d1b5ea0c1b3b6d3f69590e1a472958b61b0aa61b7b17",
                "durationMs": null,
                "value": null,
                "usage": {}
              }
            ],
            "reconciliation": null
          },
          {
            "status": "TARGETED_OCR_UNCERTAIN",
            "region": {
              "id": "6c078b9c1e0e31f0eb2e5a8d055eb88c02950e10032eefd0db8307ccfb7bfe9d",
              "fileId": "6ad7d51f98657feb4a108061",
              "pageNumber": 1,
              "inputSha256": "50937ea5e0215a544ef32931b30f76f38208630b555aeeb68ae903e647e5c72b",
              "reasons": [
                "ASTRA_FABLE_TEXT_DISAGREEMENT",
                "GEOMETRY_COVERAGE_GAP",
                "POSSIBLE_READER_OMISSION",
                "READER_UNCERTAIN_SPAN"
              ],
              "lineIds": [
                18
              ],
              "nativeCoordinates": {
                "left": 45,
                "top": 779,
                "width": 1364,
                "height": 80
              },
              "displayCoordinates": {
                "left": 45,
                "top": 779,
                "width": 1364,
                "height": 80
              },
              "sourceGeometryWordIds": [
                "word_1_99",
                "word_1_100",
                "word_1_101",
                "word_1_102",
                "word_1_103",
                "word_1_104",
                "word_1_105",
                "word_1_106",
                "word_1_107"
              ],
              "leftAnchorId": "word_1_99",
              "rightAnchorId": "word_1_107",
              "cropSha256": "8c4624c2e082aaf9db72b20a34d712191cb94910cad655b8b8386b4e36ee2c82",
              "cropDimensions": {
                "width": 1364,
                "height": 80
              },
              "transform": {
                "type": "native-pixel-translation",
                "offsetX": 45,
                "offsetY": 779,
                "scaleX": 1,
                "scaleY": 1,
                "inputWidth": 1600,
                "inputHeight": 1200
              },
              "mapping": {
                "state": "UNIQUE_STRUCTURAL_SPAN",
                "start": 484,
                "end": 517,
                "original": "shift the  of any human begin, as",
                "leftAnchor": "shift",
                "rightAnchor": "as",
                "leftAnchorId": "word_1_99",
                "rightAnchorId": "word_1_107",
                "sourceTranscriptSha256": "1f95992021575e9943279983a83ea306247a8dadf7cb39be02004ac08902cd99"
              }
            },
            "readers": [
              {
                "model": "openai/gpt-6-astra",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "8c4624c2e082aaf9db72b20a34d712191cb94910cad655b8b8386b4e36ee2c82",
                "durationMs": null,
                "value": null,
                "usage": {}
              },
              {
                "model": "anthropic/claude-fable-5.1",
                "promptSha256": "8b34ea99f3ae2cb42147e06f17c4856c1541b54ea3cb61eecf1fb584739f85de",
                "cropSha256": "8c4624c2e082aaf9db72b20a34d712191cb94910cad655b8b8386b4e36ee2c82",
                "durationMs": null,
                "value": null,
                "usage": {}
              }
            ],
            "reconciliation": null
          }
        ],
        "summary": {
          "firstPassStatus": "OCR_UNCERTAIN",
          "candidateRegionCount": 10,
          "candidateReasons": [
            "ASTRA_FABLE_SEGMENT_ROLE_CONFLICT",
            "ASTRA_FABLE_TEXT_DISAGREEMENT",
            "GEOMETRY_COVERAGE_GAP",
            "POSSIBLE_READER_OMISSION",
            "READER_UNCERTAIN_SPAN"
          ],
          "targetedRegionCount": 6,
          "resolvedTargetedCount": 0,
          "unresolvedTargetedCount": 13,
          "finalSourceStatus": "OCR_UNCERTAIN",
          "readers": [
            {
              "role": "astra",
              "calls": 6,
              "usage": {}
            },
            {
              "role": "fable",
              "calls": 6,
              "usage": {}
            }
          ]
        }
      }
    }
  ]
};
