#!/bin/bash

# Make 100 Thereoms
rm -f coq-100-theorems/cardan_ferrari.v

# delete line containing "cardan_ferrari.v"
(cd coq-100-theorems && sed -i '/cardan_ferrari.v/d' _CoqProject)

(cd coq-100-theorems && coq_makefile -f _CoqProject -o Makefile && make)

(cd software_foundations/lf && make)

# CoqGym

(cd CoqGym/coq_projects/angles && make)
(cd CoqGym/coq_projects/axiomatic-abp && make)
(cd CoqGym/coq_projects/checker && make)
(cd CoqGym/coq_projects/constructive-geometry && make)
(cd CoqGym/coq_projects/coq2html && make)
(cd CoqGym/coq_projects/coqoban && make)
(cd CoqGym/coq_projects/cours-de-coq && make)
(cd CoqGym/coq_projects/ctltctl && make)
(cd CoqGym/coq_projects/dep-map && make)
(cd CoqGym/coq_projects/domain-theory && make)
(cd CoqGym/coq_projects/free-groups && make)
(cd CoqGym/coq_projects/functions-in-zfc && make)
(cd CoqGym/coq_projects/generic-environments && make)
(cd CoqGym/coq_projects/groups && make)
(cd CoqGym/coq_projects/hedges && make)
(cd CoqGym/coq_projects/idxassoc && make)
(cd CoqGym/coq_projects/izf && make)
(cd CoqGym/coq_projects/lambda && make)
(cd CoqGym/coq_projects/miniml && make)
(cd CoqGym/coq_projects/otway-rees && make)
(cd CoqGym/coq_projects/propcalc && make)
(cd CoqGym/coq_projects/ramsey && make)
(cd CoqGym/coq_projects/rem && make)
(cd CoqGym/coq_projects/schroeder && make)
(cd CoqGym/coq_projects/subst && make)
(cd CoqGym/coq_projects/zf && make)