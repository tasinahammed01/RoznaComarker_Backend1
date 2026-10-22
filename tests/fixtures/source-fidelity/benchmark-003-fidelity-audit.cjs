'use strict';
// TEST ONLY. Post-freeze evaluation mappings; not source text authority.
module.exports={
  "textSha256": "78272c7d642e4fc8a598cd9a85ecbaf5444738d39f2fb89acba0ff696ae6063f",
  "artifactSha256": "b84c516be71870bd5f57fe1b5418321ab75a88f035bcb094ce005953e71d80ea",
  "authority": "OFFLINE_EVALUATION_OF_PROVIDER_NOTES_AGAINST_USER_CONFIRMED_GOLD",
  "uncertaintyAdjudications": [
    {
      "id": "SPAN_0",
      "classification": "CORRECTLY_UNCERTAIN",
      "scope": "OUTSIDE_BENCHMARK_BODY",
      "reason": "User confirms cropped heading is outside the body and must not be guessed. No exact heading text asserted."
    },
    {
      "id": "SEGMENT_0",
      "classification": "CORRECTLY_UNCERTAIN",
      "scope": "OUTSIDE_BENCHMARK_BODY",
      "reason": "User confirms cropped heading is outside the body and must not be guessed. No exact heading text asserted."
    },
    {
      "id": "SPAN_1",
      "classification": "UNNECESSARILY_UNCERTAIN",
      "humanStart": 648,
      "humanEnd": 653,
      "reason": "User confirms active comma and But; extra dark mark is a deleted revision artifact. Active comma omitted by Astra."
    },
    {
      "id": "SEGMENT_19",
      "classification": "UNNECESSARILY_UNCERTAIN",
      "humanStart": 648,
      "humanEnd": 653,
      "reason": "User confirms active comma and But; extra dark mark is a deleted revision artifact. Active comma omitted by Astra."
    },
    {
      "id": "SPAN_2",
      "classification": "UNNECESSARILY_UNCERTAIN",
      "humanStart": 788,
      "humanEnd": 799,
      "reason": "User confirms intentional is readable active text; Astra notes explicitly exclude the first word of the final line."
    },
    {
      "id": "SEGMENT_22",
      "classification": "UNNECESSARILY_UNCERTAIN",
      "humanStart": 788,
      "humanEnd": 799,
      "reason": "User confirms intentional is readable active text; Astra notes explicitly exclude the first word of the final line."
    }
  ]
};
