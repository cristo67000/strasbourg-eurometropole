# -*- coding: utf-8 -*-
"""Encodage varint en base 64 imprimable, pour les listes d'entiers croissants.

Chaque entier est découpé en groupes de 5 bits ; le bit 6 sert de marqueur de
continuation. Les valeurs 0-31 tiennent donc sur un caractère, ce qui est le
cas courant des écarts entre deux passages successifs (quelques minutes).

Le décodeur JavaScript équivalent se trouve dans transports.js (fonction
`decoderMinutes`) — toute modification ici doit y être reportée.
"""

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"
assert len(ALPHABET) == 64


def encoder_entier(n):
    if n < 0:
        raise ValueError("valeur négative non encodable : %r" % n)
    out = []
    while True:
        groupe = n & 31
        n >>= 5
        out.append(ALPHABET[groupe | 32] if n else ALPHABET[groupe])
        if not n:
            return "".join(out)


def encoder_suite(valeurs):
    """Encode une suite d'entiers croissants en delta + varint."""
    valeurs = sorted(valeurs)
    out = []
    precedent = 0
    for v in valeurs:
        out.append(encoder_entier(v - precedent))
        precedent = v
    return "".join(out)


_INDEX = {c: i for i, c in enumerate(ALPHABET)}


def decoder_entiers(texte):
    """Entiers indépendants (index de stations, de profils…)."""
    valeurs = []
    courant = 0
    decalage = 0
    for c in texte:
        v = _INDEX[c]
        courant |= (v & 31) << decalage
        if v & 32:
            decalage += 5
        else:
            valeurs.append(courant)
            courant = 0
            decalage = 0
    return valeurs


def decoder_suite(texte):
    """Réciproque de encoder_suite (utilisée par les contrôles de cohérence)."""
    valeurs = decoder_entiers(texte)
    total = 0
    for i, v in enumerate(valeurs):
        total += v
        valeurs[i] = total
    return valeurs
