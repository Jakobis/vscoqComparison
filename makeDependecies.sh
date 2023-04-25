#!/bin/bash

# Make 100 Thereoms
rm -f coq-100-theorems/cardan_ferrari.v

# delete line containing "cardan_ferrari.v"
(cd coq-100-theorems && sed -i '/cardan_ferrari.v/d' _CoqProject)

(cd coq-100-theorems && coq_makefile -f _CoqProject -o Makefile && make)

(cd software_foundations/lf && make)